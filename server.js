const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");

const mime = require("mime-types");
const path = require("path");
const csvWriter = require("csv-writer").createObjectCsvWriter;
const fs = require("fs");
const app = express();
app.use(cors()); // Enable CORS
app.use(bodyParser.json());

const http = require("http");
const WebSocket = require("ws");

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const archiver = require("archiver");

let clients = {};

wss.on("connection", (ws) => {
  const id = new Date().getTime();
  clients[id] = ws;

  ws.on("close", () => {
    delete clients[id];
  });
});

function sendProgressToClients(progress) {
  Object.values(clients).forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ progress }));
    }
  });
}

// Endpoint to get the access token
app.post("/api/token", async (req, res) => {
  const { username, password, client_id, client_secret } = req.body;
  try {
    const response = await axios.post(
      "https://schweiger.egnyte.com/puboauth/token",
      null,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        params: {
          grant_type: "password",
          username,
          password,
          client_id,
          client_secret,
        },
      }
    );
    console.log(client_id);

    res.json(response.data);
  } catch (error) {
    console.error(
      "Error fetching token:",
      error.response ? error.response.data : error.message
    );
    res.status(500).json({ error: "Failed to fetch token" });
  }
});

// Endpoint to fetch data from Egnyte file system
app.post("/api/files", async (req, res) => {
  const accessToken = req.headers.authorization;
  const path = req.body.path;

  try {
    const response = await axios.get(
      `https://schweiger.egnyte.com/pubapi/v1/fs/${path}`,
      {
        headers: {
          Authorization: accessToken,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error(
      "Error fetching files:",
      error.response ? error.response.data : error.message
    );
    res.status(500).json({ error: "Failed to fetch files" });
  }
});

app.post("/api/filedown", async (req, res) => {
  const accessToken = req.headers.authorization;
  const { filePath } = req.body;

  console.log("Request to download file:", filePath);

  try {
    // Fetch the file from the remote server
    const response = await axios.get(
      `https://schweiger.egnyte.com/pubapi/v1/fs-content/${filePath}`,
      {
        headers: {
          Authorization: accessToken,
        },
        responseType: "stream",
      }
    );

    const fileName = filePath.split("/").pop();
    const contentType = mime.lookup(fileName) || "application/octet-stream";

    // Set headers for the file download
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileName)}"`
    );
    res.setHeader("Content-Type", contentType);

    const totalLength = parseInt(response.headers["content-length"], 10);
    let downloadedLength = 0;

    // Listen to the 'data' event to track progress
    response.data.on("data", (chunk) => {
      downloadedLength += chunk.length;
      const progress = (downloadedLength / totalLength) * 100;

      // Send progress to clients
      sendProgressToClients(Math.round(progress));
    });

    // Pipe the data stream from the remote file to the client
    response.data.pipe(res);

    response.data.on("end", () => {
      console.log(`File ${fileName} successfully streamed to client.`);
    });

    response.data.on("error", (err) => {
      console.error(`Error streaming file ${fileName}:`, err.message);
      if (!res.headersSent) {
        res.status(500).send("Error streaming the file.");
      }
    });
  } catch (error) {
    console.error("Error fetching the file:", error.message);
    if (!res.headersSent) {
      res.status(500).send("Error handling request.");
    }
  }
});

function convertPathsToCSV(paths) {
  const escapeCSVField = (field) => {
    if (field.includes('"')) {
      field = '"' + field.replace(/"/g, '""') + '"';
    }
    if (field.includes(",") || field.includes("\n")) {
      field = '"' + field + '"';
    }
    return field;
  };

  const header = "Name,Type,Created,Modified,Extension,Path\n";
  const rows = paths
    ?.map(
      (p) =>
        `${escapeCSVField(p.name)},${escapeCSVField(p.type)},${escapeCSVField(
          p.created
        )},${escapeCSVField(p.modified)},${escapeCSVField(
          p.extension
        )},${escapeCSVField(p.path)}`
    )
    .join("\n");

  return header + rows;
}

async function fetchFolderData(accessToken, folderPath, progressCallback) {
  if (folderPath[0] !== "/") folderPath = "/" + folderPath;
  const allPaths = [];
  console.log(
    folderPath,
    `https://schweiger.egnyte.com/pubapi/v1/fs${folderPath}`
  );

  try {
    const response = await axios.get(
      `https://schweiger.egnyte.com/pubapi/v1/fs${folderPath}`,
      {
        headers: {
          Authorization: accessToken,
        },
      }
    );

    const data = response.data;

    console.log(data);

    allPaths.push({
      name: data.name,
      path: data.path,
      extension: data.is_folder ? "" : data.name.split(".").pop().toLowerCase(),
      created: new Date(data.uploaded).toLocaleString(),
      modified: new Date(data.last_modified).toLocaleString(),
      type: "folder",
    });

    if (progressCallback) {
      progressCallback(allPaths.length);
    }

    if (data.folders && data.folders.length > 0) {
      for (const folder of data.folders) {
        allPaths.push(
          ...(await fetchFolderData(
            accessToken,
            folder.path.slice(1),
            progressCallback
          ))
        );
      }
    }

    if (data.files && data.files.length > 0) {
      for (const file of data.files) {
        allPaths.push({
          name: file.name,
          path: file.path,
          extension: file.is_folder
            ? ""
            : file.name.split(".").pop().toLowerCase(),
          created: new Date(file.uploaded).toLocaleString(),
          modified: new Date(file.last_modified).toLocaleString(),
          type: "file",
        });

        if (progressCallback) {
          progressCallback(allPaths.length);
        }
      }
    }

    return allPaths;
  } catch (error) {
    console.error(`Error fetching data for path ${folderPath}:`, error.message);
    return allPaths;
  }
}

app.post("/api/download", async (req, res) => {
  const accessToken = req.headers.authorization;
  const { path } = req.body || "";

  if (accessToken && path) {
    let totalItems = 0;
    const paths = await fetchFolderData(accessToken, path, (currentCount) => {
      totalItems += currentCount;
      sendProgressToClients(totalItems);
    });

    const csvContent = convertPathsToCSV(paths);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.replace(/[\/\\?%*:|"<>]/g, "_")}.csv"`
    );
    res.setHeader("Content-Type", "text/csv");

    res.send(csvContent);
  } else {
    res.json({ error: "No token or path" });
  }
});

async function fetchAllFiles(
  accessToken,
  folderPath,
  archive,
  processedFiles = 0,
  progressCallback
) {
  console.log(`Fetching folder path: ${folderPath}`);

  try {
    const response = await axios.get(
      `https://schweiger.egnyte.com/pubapi/v1/fs/${folderPath}`,
      {
        headers: {
          Authorization: accessToken,
        },
      }
    );

    const data = response.data;

    let totalFiles = (data.files || []).length;

    // Fetch and store files in the current folder sequentially
    for (const file of data.files || []) {
      console.log(`Fetching file: ${file.path}`);
      try {
        const fileResponse = await axios.get(
          `https://schweiger.egnyte.com/pubapi/v1/fs-content${file.path}`,
          {
            headers: {
              Authorization: accessToken,
            },
            responseType: "stream",
          }
        );

        const relativePath = file.path.replace(`${folderPath}/`, "");

        await new Promise((resolve, reject) => {
          const fileStream = fileResponse.data;

          fileStream.on("end", () => {
            console.log(`Finished streaming file: ${file.path}`);
            processedFiles++;
            const progress = Math.round((processedFiles / totalFiles) * 100);

            // Send progress update if a callback is provided
            if (progressCallback) {
              progressCallback(processedFiles);
            }

            resolve();
          });

          fileStream.on("error", (streamErr) => {
            console.error(
              `Stream error for file ${file.path}:`,
              streamErr.message
            );
            reject(streamErr);
          });

          archive
            .append(fileStream, { name: relativePath })
            .on("close", () => {
              console.log(`Finished writing file to archive: ${relativePath}`);
            })
            .on("error", (archiveErr) => {
              console.error(
                `Archive append error for file ${file.path}:`,
                archiveErr.message
              );
              reject(archiveErr);
            });
        });
      } catch (fileError) {
        console.error(`Error fetching file ${file.path}:`, fileError.message);
        throw fileError;
      }
    }

    // Recursively fetch and store files in subfolders
    for (const folder of data.folders || []) {
      const subfolderFiles = await fetchAllFiles(
        accessToken,
        folder.path,
        archive,
        processedFiles,
        progressCallback
      );
      totalFiles += subfolderFiles.totalFiles;
      processedFiles += subfolderFiles.processedFiles;
    }

    return { totalFiles, processedFiles };
  } catch (error) {
    console.error(
      `Error fetching files for folder ${folderPath}:`,
      error.message
    );
    throw error;
  }
}

app.post("/api/folder-download", async (req, res) => {
  const accessToken = req.headers.authorization;
  const { folderPath } = req.body;
  const outputPath = path.join(__dirname, `${folderPath.split("/").pop()}.zip`);

  try {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { store: true });

    archive.on("error", (err) => {
      console.error("Archive error:", err.message);
      res.status(500).send({ error: err.message });
    });

    archive.pipe(output);

    let totalFiles = 0;
    let processedFiles = 0;

    await fetchAllFiles(accessToken, folderPath, archive, 0, (progress) => {
      sendProgressToClients(progress);
    });

    await archive.finalize();

    output.on("close", () => {
      res.download(outputPath, (err) => {
        if (err) {
          console.error("Error sending file:", err.message);
          res.status(500).send("Failed to download the file.");
        }

        // Optional: Delete the file after sending it
        fs.unlink(outputPath, (err) => {
          if (err) console.error("Error deleting file:", err.message);
        });
      });
    });
  } catch (error) {
    console.error("Error downloading folder:", error.message);
    res.status(500).send("Error handling folder download.");
  }
});

const PORT = process.env.PORT || 8001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
