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
1;
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
app.get("/api/files", async (req, res) => {
  const accessToken = req.headers.authorization;
  const { path } = req.query;

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
  // const fileName = path.basename(filePath); // Extract file name from the path
  // const localFilePath = path.join(__dirname, fileName);

  // // Save the file to the local filesystem
  // fs.writeFileSync(localFilePath, response.data);

  // res.download(localFilePath, fileName, (err) => {
  //   if (err) {
  //     console.error("File download error:", err);
  //     res.status(500).send("Failed to download the file");
  //   }
  //   // Delete the file after download to free up space
  //   fs.unlinkSync(localFilePath);
  // });

  // const contentType = response.headers["content-type"];
  // const contentDisposition = response.headers["content-disposition"];

  // res.setHeader("Content-Type", contentType);
  // if (contentDisposition) {
  //   res.setHeader("Content-Disposition", contentDisposition);
  // }

  // // res.send(response.body); // Send the binary data
});

async function fetchFolderData(accessToken, folderPath) {
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
    const allPaths = [];

    // Collect current folder path
    allPaths.push({
      type: "folder",
      path: data.path,
    });

    // Collect subfolder paths and recursively fetch their data
    if (data.folders && data.folders.length > 0) {
      for (const folder of data.folders) {
        allPaths.push(...(await fetchFolderData(accessToken, folder.path)));
      }
    }

    // Collect file paths
    if (data.files && data.files.length > 0) {
      for (const file of data.files) {
        allPaths.push({
          type: "file",
          path: file.path,
        });
      }
    }

    return allPaths;
  } catch (error) {
    console.error(`Error fetching data for path ${folderPath}:`, error.message);
    return [];
  }
}

async function writePathsToCSV(paths, outputFilePath) {
  const csv = csvWriter({
    path: outputFilePath,
    header: [
      { id: "type", title: "TYPE" },
      { id: "path", title: "PATH" },
    ],
  });

  await csv.writeRecords(paths);
}

app.get("/api/download", async (req, res) => {
  const accessToken = req.headers.authorization;
  const { folderpath } = req.query || "/";

  //   const paths = await fetchFolderData(accessToken, folderpath);
  const paths = [
    {
      type: "folder",
      path: "/",
    },
    {
      type: "folder",
      path: "/Private",
    },
    {
      type: "folder",
      path: "/Private/agonzalez",
    },
    {
      type: "folder",
      path: "/Private/agonzalez/210284.P USTX01 UPS A&B",
    },
    {
      type: "folder",
      path: "/Private/agonzalez/210284.P USTX01 UPS A&B/Notes",
    },
    {
      type: "file",
      path: "/Private/agonzalez/210284.P USTX01 UPS A&B/Notes/Meeting Notes 11.15.23.pdf",
    },
  ];

  const outputFilePath = path.join(__dirname, folderpath + ".csv");
  await writePathsToCSV(paths, outputFilePath);

  res.json(paths);
});

const PORT = process.env.PORT || 8001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
