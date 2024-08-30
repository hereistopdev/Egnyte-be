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

app.get("/api/filedown", async (req, res) => {
  const accessToken = req.headers.authorization;
  const { filePath } = req.query;

  try {
    const response = await axios.get(
      `https://schweiger.egnyte.com/pubapi/v1/fs-content/${filePath}`,
      {
        headers: {
          Authorization: accessToken,
        },
        responseType: "stream",
      }
    );

    let fileName = filePath.split("/").pop();

    const contentType = mime.lookup(fileName) || "application/octet-stream";

    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", contentType);

    response.data.pipe(res);
  } catch (error) {
    console.error("Error redirecting request:", error.message);
    res.status(500).send("Error handling request.");
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
  const allPaths = [];

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
          ...(await fetchFolderData(accessToken, folder.path, progressCallback))
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

async function fetchAllFiles(accessToken, folderPath, archive) {
  console.log("Folder path: ", folderPath);

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

    // Fetch and store files in the current folder
    if (data.files && data.files.length > 0) {
      for (const file of data.files) {
        console.log("file's path: ", file.path);
        const fileResponse = await axios.get(
          `https://schweiger.egnyte.com/pubapi/v1/fs-content/${file.path}`,
          {
            headers: {
              Authorization: accessToken,
            },
            responseType: "stream",
          }
        );

        // Append file to the archive
        const relativePath = file.path.replace(`${folderPath}/`, "");
        archive.append(fileResponse.data, { name: relativePath });
      }
    }

    // Recursively fetch and store files in subfolders
    if (data.folders && data.folders.length > 0) {
      for (const folder of data.folders) {
        await fetchAllFiles(accessToken, folder.path, archive);
      }
    }
  } catch (error) {
    console.error(
      `Error fetching files for folder ${folderPath}:`,
      error.message
    );
    throw error;
  }
}

app.get("/api/folder-download", async (req, res) => {
  const accessToken = req.headers.authorization;
  const { folderPath } = req.query;

  try {
    // Set up the zip file
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${folderPath.split("/").pop()}.zip"`
    );
    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip", {
      store: true, // Sets the compression level
    });
    archive.on("error", (err) => {
      console.error("Archive error:", err.message);
      res.status(500).send({ error: err.message });
    });

    archive.pipe(res);

    // Fetch all files and add them to the archive
    await fetchAllFiles(accessToken, folderPath, archive);

    // Finalize the archive (this is important to signal the end of the stream)
    archive.finalize();
    console.log("Archive finalized successfully", archive);
  } catch (error) {
    console.error("Error downloading folder:", error.message);
    res.status(500).send("Error handling folder download.");
  }
});

const PORT = process.env.PORT || 8001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
