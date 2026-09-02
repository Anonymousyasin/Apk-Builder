import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import fs from "fs";
import { execSync } from "child_process";
import multer from "multer";
import AdmZip from "adm-zip";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Helper to make GitHub API requests
async function githubRequest(endpoint: string, pat: string, options: RequestInit = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `https://api.github.com${endpoint}`;
  
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${pat}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Github-APK-Builder-App",
    ...(options.headers as Record<string, string> || {})
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  // Handle 302 manually if requested
  if (options.redirect === "manual" && response.status === 302) {
    return response;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${text || response.statusText}`);
  }

  return response;
}

// Helper to parse repo URL
function parseRepoUrl(url: string) {
  let cleanUrl = url.trim();
  cleanUrl = cleanUrl.replace(/\.git$/, "");
  
  if (cleanUrl.includes("github.com/")) {
    const parts = cleanUrl.split("github.com/");
    if (parts.length > 1) {
      const repoParts = parts[1].split("/");
      if (repoParts.length >= 2) {
        return { owner: repoParts[0], repo: repoParts[1] };
      }
    }
  } else {
    const parts = cleanUrl.split("/");
    if (parts.length === 2) {
      return { owner: parts[0], repo: parts[1] };
    }
  }
  
  return null;
}

// Map dynamic or full numeric NDK versions (e.g. 27.1.12297006) to standard release codes (e.g. r27b)
function mapNdkVersionToRelease(version: string): string {
  if (!version) return "r25c";
  
  // If it already starts with 'r' and has numbers (e.g. 'r25c', 'r27b'), return it
  if (/^r\d+[a-z]?$/i.test(version)) {
    return version.toLowerCase();
  }

  const parts = version.trim().split(".");
  if (parts.length >= 2) {
    const major = parseInt(parts[0], 10);
    const minor = parseInt(parts[1], 10);

    if (!isNaN(major) && !isNaN(minor)) {
      // Common minor version mapping:
      // 0 -> r<major>
      // 1 -> r<major>b
      // 2 -> r<major>c
      // 3 -> r<major>d
      // 4 -> r<major>e
      const letterMap = ["", "b", "c", "d", "e", "f", "g"];
      const suffix = letterMap[minor] !== undefined ? letterMap[minor] : "";
      return `r${major}${suffix}`;
    }
  }

  // If we couldn't parse it but it's a number, guess major version
  const numericOnly = version.replace(/[^0-9]/g, "");
  if (numericOnly.length >= 2) {
    const major = parseInt(numericOnly.substring(0, 2), 10);
    if (!isNaN(major) && major >= 16 && major <= 32) {
      return `r${major}`;
    }
  }

  return "r25c"; // default safe fallback
}

// Helper to dynamically auto-detect project settings (Java version, NDK version, C++ builds)
async function autoDetectProjectSettings(owner: string, repo: string, pat: string, defaultBranch: string) {
  let javaVersion = "17"; // default
  let ndkVersion: string | null = null;
  let usesNdk = false;
  let buildCommand = "./gradlew assembleDebug";

  try {
    // 1. Try fetching app/build.gradle
    let gradleContent = "";
    try {
      const gradleRes = await githubRequest(`/repos/${owner}/${repo}/contents/app/build.gradle?ref=${defaultBranch}`, pat);
      const gradleData = await gradleRes.json();
      if (gradleData.content) {
        gradleContent = Buffer.from(gradleData.content, "base64").toString("utf-8");
      }
    } catch (err) {
      // Maybe it's build.gradle in the root, or app/build.gradle.kts
      try {
        const gradleRes = await githubRequest(`/repos/${owner}/${repo}/contents/build.gradle?ref=${defaultBranch}`, pat);
        const gradleData = await gradleRes.json();
        if (gradleData.content) {
          gradleContent = Buffer.from(gradleData.content, "base64").toString("utf-8");
        }
      } catch (err2) {
        try {
          const gradleRes = await githubRequest(`/repos/${owner}/${repo}/contents/app/build.gradle.kts?ref=${defaultBranch}`, pat);
          const gradleData = await gradleRes.json();
          if (gradleData.content) {
            gradleContent = Buffer.from(gradleData.content, "base64").toString("utf-8");
          }
        } catch (err3) {}
      }
    }

    if (gradleContent) {
      // Detect Java version
      const javaMatch = gradleContent.match(/JavaVersion\.VERSION_(\d+_\d+|\d+)/i) || 
                        gradleContent.match(/sourceCompatibility\s*=\s*['"]?(\d+)['"]?/i) ||
                        gradleContent.match(/targetCompatibility\s*=\s*['"]?(\d+)['"]?/i) ||
                        gradleContent.match(/jvmTarget\s*=\s*['"]?(\d+)['"]?/i) ||
                        gradleContent.match(/toolchain\s*\{\s*languageVersion\s*=\s*JavaLanguageVersion\.of\((\d+)\)/i);
      
      if (javaMatch) {
        let detectedVer = javaMatch[1];
        if (detectedVer === "1_8" || detectedVer === "8" || detectedVer === "1.8" || detectedVer === "11") {
          javaVersion = "17"; // Modern Gradle 8+ and plugins require at least JDK 17 to execute
        } else if (detectedVer === "17" || detectedVer === "21") {
          javaVersion = detectedVer;
        }
      }

      // Detect NDK version
      const ndkMatch = gradleContent.match(/ndkVersion\s*=?\s*['"]([^'"]+)['"]/i);
      if (ndkMatch) {
        ndkVersion = ndkMatch[1];
        usesNdk = true;
      }

      // Check if externalNativeBuild or CMakeLists is referenced
      if (gradleContent.includes("externalNativeBuild") || gradleContent.includes("CMakeLists.txt") || gradleContent.includes("ndk") || gradleContent.includes("jni")) {
        usesNdk = true;
      }
    }

    // 2. Double check if CMakeLists.txt exists in app/ or root
    if (!usesNdk) {
      try {
        await githubRequest(`/repos/${owner}/${repo}/contents/app/CMakeLists.txt?ref=${defaultBranch}`, pat);
        usesNdk = true;
      } catch (e) {
        try {
          await githubRequest(`/repos/${owner}/${repo}/contents/CMakeLists.txt?ref=${defaultBranch}`, pat);
          usesNdk = true;
        } catch (e2) {}
      }
    }

    // 3. Check for specific folders like jni or cpp
    if (!usesNdk) {
      try {
        await githubRequest(`/repos/${owner}/${repo}/contents/app/src/main/jni?ref=${defaultBranch}`, pat);
        usesNdk = true;
      } catch (e) {
        try {
          await githubRequest(`/repos/${owner}/${repo}/contents/app/src/main/cpp?ref=${defaultBranch}`, pat);
          usesNdk = true;
        } catch (e2) {
          try {
            await githubRequest(`/repos/${owner}/${repo}/contents/src/main/jni?ref=${defaultBranch}`, pat);
            usesNdk = true;
          } catch (e3) {}
        }
      }
    }

  } catch (err) {
    console.warn("Auto-detection warning:", err);
  }

  return { javaVersion, ndkVersion, usesNdk, buildCommand };
}

// 1. Get authenticated user
app.post("/api/github/user", async (req, res) => {
  try {
    const pat = req.body.pat || process.env.DEFAULT_GITHUB_PAT;
    if (!pat) {
      return res.status(401).json({ error: "No GitHub Personal Access Token (PAT) provided" });
    }

    const response = await githubRequest("/user", pat);
    const data = await response.json();
    
    res.json({
      login: data.login,
      avatar_url: data.avatar_url,
      name: data.name,
      html_url: data.html_url
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Trigger the APK build
app.post("/api/build/trigger", async (req, res) => {
  try {
    const { repoUrl, javaVersion = "auto", buildCommand = "auto" } = req.body;
    const pat = req.body.pat || process.env.DEFAULT_GITHUB_PAT;

    if (!repoUrl) {
      return res.status(400).json({ error: "Repository URL is required" });
    }
    if (!pat) {
      return res.status(401).json({ error: "GitHub Personal Access Token (PAT) is required" });
    }

    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) {
      return res.status(400).json({ error: "Invalid GitHub repository URL format. Please use 'https://github.com/owner/repo' or 'owner/repo'" });
    }

    const { owner: originalOwner, repo } = parsed;

    // A. Get authenticated user's login name
    const userRes = await githubRequest("/user", pat);
    const userData = await userRes.json();
    const username = userData.login;

    let targetOwner = originalOwner;
    let isFork = false;

    // B. Check if owner is not the current user. If so, we fork!
    if (originalOwner.toLowerCase() !== username.toLowerCase()) {
      isFork = true;
      targetOwner = username;

      // Check if fork already exists
      let forkExists = false;
      try {
        await githubRequest(`/repos/${username}/${repo}`, pat);
        forkExists = true;
      } catch (err) {
        // Fork doesn't exist yet
      }

      if (!forkExists) {
        // Create fork
        await githubRequest(`/repos/${originalOwner}/${repo}/forks`, pat, {
          method: "POST"
        });

        // Poll for fork creation (up to 15 seconds)
        let attempts = 0;
        let created = false;
        while (attempts < 10) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          try {
            await githubRequest(`/repos/${username}/${repo}`, pat);
            created = true;
            break;
          } catch (err) {
            attempts++;
          }
        }

        if (!created) {
          return res.status(504).json({ error: "Forking timed out. Please try again in a few moments." });
        }
      }
    }

    // C. Get repository details to find default branch
    const repoRes = await githubRequest(`/repos/${targetOwner}/${repo}`, pat);
    const repoData = await repoRes.json();
    const defaultBranch = repoData.default_branch || "main";

    // D. Enable actions on repository (just in case)
    try {
      await githubRequest(`/repos/${targetOwner}/${repo}/actions/permissions`, pat, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      // Ignore if this fails due to admin constraints
    }

    // Run Auto-Detection
    let finalJavaVersion = javaVersion;
    let finalBuildCommand = buildCommand;
    let detectedUsesNdk = false;
    let detectedNdkVersion: string | null = null;

    const detection = await autoDetectProjectSettings(targetOwner, repo, pat, defaultBranch);
    
    if (javaVersion === "auto") {
      finalJavaVersion = detection.javaVersion;
    }
    // Enforce modern JDK 17 as the absolute runtime minimum to avoid AGP/LSPosed plugin execution failure
    if (finalJavaVersion === "11" || finalJavaVersion === "8" || !finalJavaVersion) {
      finalJavaVersion = "17";
    }
    if (buildCommand === "auto") {
      finalBuildCommand = detection.buildCommand;
    }
    detectedUsesNdk = detection.usesNdk;
    detectedNdkVersion = detection.ndkVersion;

    console.log(`Auto-detection completed. Java: ${finalJavaVersion}, NDK: ${detectedUsesNdk} (${detectedNdkVersion || "default"}), Command: ${finalBuildCommand}`);

    let ndkStep = "";
    if (detectedUsesNdk) {
      const mappedNdkVersion = mapNdkVersionToRelease(detectedNdkVersion || "");
      ndkStep = `
      - name: Set up NDK
        uses: nttld/setup-ndk@v1
        with:
          ndk-version: '${mappedNdkVersion}'
`;
    }

    // E. Commit the workflow file
    const workflowPath = ".github/workflows/android-apk-builder.yml";
    const workflowYaml = `name: Android APK Builder

on:
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Set up JDK ${finalJavaVersion}
        uses: actions/setup-java@v4
        with:
          distribution: 'zulu'
          java-version: '${finalJavaVersion}'
          cache: 'gradle'

      - name: Accept Android SDK Licenses
        run: |
          yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses || true
${ndkStep}
      - name: Repair or Restore Gradle Wrapper
        run: |
          mkdir -p gradle/wrapper
          if [ ! -f "gradle/wrapper/gradle-wrapper.jar" ]; then
            echo "gradle-wrapper.jar is missing! Restoring with official bootstrap jar..."
            curl -Lo gradle/wrapper/gradle-wrapper.jar https://raw.githubusercontent.com/gradle/gradle/v8.5.0/gradle/wrapper/gradle-wrapper.jar
          fi
          if [ ! -f "gradle/wrapper/gradle-wrapper.properties" ]; then
            echo "gradle-wrapper.properties is missing! Generating standard config..."
            echo "distributionBase=GRADLE_USER_HOME" > gradle/wrapper/gradle-wrapper.properties
            echo "distributionPath=wrapper/dists" >> gradle/wrapper/gradle-wrapper.properties
            echo "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip" >> gradle/wrapper/gradle-wrapper.properties
            echo "zipStoreBase=GRADLE_USER_HOME" >> gradle/wrapper/gradle-wrapper.properties
            echo "zipStorePath=wrapper/dists" >> gradle/wrapper/gradle-wrapper.properties
          fi
          chmod +x gradlew || true

      - name: Build with Gradle
        run: |
          if [ -f "./gradlew" ]; then
            ${finalBuildCommand} --no-daemon
          else
            gradle assembleDebug --no-daemon
          fi

      - name: Find APKs
        id: find_apks
        run: |
          echo "Finding APKs..."
          mkdir -p build-output
          find . -name "*.apk" -not -path "*/build-output/*" -exec cp {} build-output/ \\;
          echo "APKs copied:"
          ls -R build-output

      - name: Upload APKs
        uses: actions/upload-artifact@v4
        with:
          name: android-apk
          path: build-output/
`;

    // Check if workflow file already exists to get its SHA
    let sha: string | undefined;
    try {
      const fileRes = await githubRequest(`/repos/${targetOwner}/${repo}/contents/${workflowPath}?ref=${defaultBranch}`, pat);
      const fileData = await fileRes.json();
      sha = fileData.sha;
    } catch (err) {
      // File doesn't exist yet, which is fine
    }

    // Create or update the workflow file
    const base64Content = Buffer.from(workflowYaml).toString("base64");
    await githubRequest(`/repos/${targetOwner}/${repo}/contents/${workflowPath}`, pat, {
      method: "PUT",
      body: JSON.stringify({
        message: "Set up Android APK Builder workflow via App with Auto-detection",
        content: base64Content,
        sha,
        branch: defaultBranch
      }),
      headers: { "Content-Type": "application/json" }
    });

    // Wait a brief moment for GitHub to register the workflow
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // F. Trigger the workflow via workflow_dispatch
    await githubRequest(`/repos/${targetOwner}/${repo}/actions/workflows/android-apk-builder.yml/dispatches`, pat, {
      method: "POST",
      body: JSON.stringify({
        ref: defaultBranch
      }),
      headers: { "Content-Type": "application/json" }
    });

    // Poll to find the triggered run
    let runId: number | null = null;
    let attempts = 0;
    while (attempts < 10) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const runsRes = await githubRequest(`/repos/${targetOwner}/${repo}/actions/runs?event=workflow_dispatch&branch=${defaultBranch}`, pat);
        const runsData = await runsRes.json();
        const runs = runsData.workflow_runs || [];
        
        // Find the most recent run for our workflow
        const ourRun = runs.find((r: any) => r.path && r.path.endsWith("android-apk-builder.yml"));
        if (ourRun) {
          runId = ourRun.id;
          break;
        }
      } catch (err) {
        // Run list might be empty or query failed temporarily
      }
      attempts++;
    }

    res.json({
      owner: targetOwner,
      repo,
      runId,
      branch: defaultBranch,
      isFork,
      originalOwner,
      detectedConfig: {
        javaVersion: finalJavaVersion,
        usesNdk: detectedUsesNdk,
        ndkVersion: detectedNdkVersion,
        buildCommand: finalBuildCommand
      }
    });

  } catch (error: any) {
    console.error("Trigger error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2b. Upload a ZIP, create a repo, push project, and trigger build
app.post("/api/build/upload-zip", upload.single("zip"), async (req, res) => {
  let tempDir = "";
  try {
    const pat = req.body.pat || process.env.DEFAULT_GITHUB_PAT;
    const javaVersion = req.body.javaVersion || "auto";
    const buildCommand = req.body.buildCommand || "auto";

    if (!pat) {
      return res.status(401).json({ error: "GitHub Personal Access Token (PAT) is required" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "ZIP file is required" });
    }

    // A. Get authenticated user's login name
    const userRes = await githubRequest("/user", pat);
    const userData = await userRes.json();
    const username = userData.login;

    // B. Create a new repository on user's GitHub
    const repoName = `android-project-${Date.now()}`;
    console.log(`Creating GitHub repository ${username}/${repoName}...`);
    const createRepoRes = await githubRequest("/user/repos", pat, {
      method: "POST",
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: "Android project uploaded via APK Builder App",
        auto_init: false
      }),
      headers: { "Content-Type": "application/json" }
    });
    const createdRepo = await createRepoRes.json();

    // C. Extract uploaded ZIP to a temporary directory
    tempDir = path.join("/tmp", `zip-repo-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    console.log(`Extracting ZIP file to ${tempDir}...`);
    const zip = new AdmZip(req.file.buffer);
    zip.extractAllTo(tempDir, true);

    // If zip contains a single root subdirectory, find it and make it the project directory
    let projectDir = tempDir;
    const files = fs.readdirSync(tempDir).filter(f => f !== "__MACOSX" && !f.startsWith("."));
    if (files.length === 1 && fs.statSync(path.join(tempDir, files[0])).isDirectory()) {
      projectDir = path.join(tempDir, files[0]);
    }

    // Ensure we have some basic files to push
    if (!fs.existsSync(projectDir)) {
      throw new Error("Extracted directory structure is empty or invalid.");
    }

    // D. Initialize local git, commit and push to GitHub
    console.log(`Initializing local git repository in ${projectDir}...`);
    const cloneUrl = `https://x-access-token:${pat}@github.com/${username}/${repoName}.git`;

    execSync("git init", { cwd: projectDir });
    execSync('git config user.name "Android APK Builder"', { cwd: projectDir });
    execSync('git config user.email "apk-builder@example.com"', { cwd: projectDir });
    
    // Create a simple .gitignore if none exists to avoid committing IDE temp files
    const gitignorePath = path.join(projectDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, ".gradle/\nbuild/\nlocal.properties\n*.iml\n.idea/\n");
    }

    execSync("git add .", { cwd: projectDir });
    try {
      execSync('git commit -m "Upload Android project zip"', { cwd: projectDir });
    } catch (e) {
      // Empty commit, might happen if git add is empty
      execSync('git commit --allow-empty -m "Upload Android project zip"', { cwd: projectDir });
    }

    execSync("git branch -M main", { cwd: projectDir });
    execSync(`git remote add origin ${cloneUrl}`, { cwd: projectDir });
    
    console.log(`Pushing code to main branch on GitHub...`);
    execSync("git push -u origin main", { cwd: projectDir });

    // Wait a brief moment for GitHub to process the push
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // E. Now trigger the build on this new repository!
    console.log(`Pushed code successfully. Triggering the APK build workflow on ${username}/${repoName}...`);
    
    const defaultBranch = "main";

    // Run Auto-Detection on our freshly pushed repo
    let finalJavaVersion = javaVersion;
    let finalBuildCommand = buildCommand;
    let detectedUsesNdk = false;
    let detectedNdkVersion: string | null = null;

    const detection = await autoDetectProjectSettings(username, repoName, pat, defaultBranch);
    
    if (javaVersion === "auto") {
      finalJavaVersion = detection.javaVersion;
    }
    // Enforce modern JDK 17 as the absolute runtime minimum
    if (finalJavaVersion === "11" || finalJavaVersion === "8" || !finalJavaVersion) {
      finalJavaVersion = "17";
    }
    if (buildCommand === "auto") {
      finalBuildCommand = detection.buildCommand;
    }
    detectedUsesNdk = detection.usesNdk;
    detectedNdkVersion = detection.ndkVersion;

    let ndkStep = "";
    if (detectedUsesNdk) {
      const mappedNdkVersion = mapNdkVersionToRelease(detectedNdkVersion || "");
      ndkStep = `
      - name: Set up NDK
        uses: nttld/setup-ndk@v1
        with:
          ndk-version: '${mappedNdkVersion}'
`;
    }

    // Commit workflow file
    const workflowPath = ".github/workflows/android-apk-builder.yml";
    const workflowYaml = `name: Android APK Builder

on:
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Set up JDK ${finalJavaVersion}
        uses: actions/setup-java@v4
        with:
          distribution: 'zulu'
          java-version: '${finalJavaVersion}'
          cache: 'gradle'

      - name: Accept Android SDK Licenses
        run: |
          yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses || true
\${ndkStep}
      - name: Repair or Restore Gradle Wrapper
        run: |
          mkdir -p gradle/wrapper
          if [ ! -f "gradle/wrapper/gradle-wrapper.jar" ]; then
            echo "gradle-wrapper.jar is missing! Restoring with official bootstrap jar..."
            curl -Lo gradle/wrapper/gradle-wrapper.jar https://raw.githubusercontent.com/gradle/gradle/v8.5.0/gradle/wrapper/gradle-wrapper.jar
          fi
          if [ ! -f "gradle/wrapper/gradle-wrapper.properties" ]; then
            echo "gradle-wrapper.properties is missing! Generating standard config..."
            echo "distributionBase=GRADLE_USER_HOME" > gradle/wrapper/gradle-wrapper.properties
            echo "distributionPath=wrapper/dists" >> gradle/wrapper/gradle-wrapper.properties
            echo "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip" >> gradle/wrapper/gradle-wrapper.properties
            echo "zipStoreBase=GRADLE_USER_HOME" >> gradle/wrapper/gradle-wrapper.properties
            echo "zipStorePath=wrapper/dists" >> gradle/wrapper/gradle-wrapper.properties
          fi
          chmod +x gradlew || true

      - name: Build with Gradle
        run: |
          if [ -f "./gradlew" ]; then
            \${finalBuildCommand} --no-daemon
          else
            gradle assembleDebug --no-daemon
          fi

      - name: Find APKs
        id: find_apks
        run: |
          echo "Finding APKs..."
          mkdir -p build-output
          find . -name "*.apk" -not -path "*/build-output/*" -exec cp {} build-output/ \\;
          echo "APKs copied:"
          ls -R build-output

      - name: Upload APKs
        uses: actions/upload-artifact@v4
        with:
          name: android-apk
          path: build-output/
`.replace(/\${ndkStep}/g, ndkStep).replace(/\${finalBuildCommand}/g, finalBuildCommand);

    let existingSha: string | null = null;
    try {
      const existingRes = await githubRequest(`/repos/${username}/${repoName}/contents/${workflowPath}`, pat);
      const existingData = await existingRes.json();
      existingSha = existingData.sha;
    } catch (e) {
      console.log(`Workflow file does not exist yet or read failed (safe fallback to create):`, e);
    }

    const base64Content = Buffer.from(workflowYaml).toString("base64");
    const putBody: any = {
      message: "Set up Android APK Builder workflow via App ZIP upload",
      content: base64Content,
      branch: defaultBranch
    };
    if (existingSha) {
      putBody.sha = existingSha;
    }

    await githubRequest(`/repos/${username}/${repoName}/contents/${workflowPath}`, pat, {
      method: "PUT",
      body: JSON.stringify(putBody),
      headers: { "Content-Type": "application/json" }
    });

    // Wait for register
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Trigger workflow
    await githubRequest(`/repos/${username}/${repoName}/actions/workflows/android-apk-builder.yml/dispatches`, pat, {
      method: "POST",
      body: JSON.stringify({ ref: defaultBranch }),
      headers: { "Content-Type": "application/json" }
    });

    // Poll to find the triggered run
    let runId: number | null = null;
    let attempts = 0;
    while (attempts < 10) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const runsRes = await githubRequest(`/repos/${username}/${repoName}/actions/runs?event=workflow_dispatch&branch=${defaultBranch}`, pat);
        const runsData = await runsRes.json();
        const runs = runsData.workflow_runs || [];
        const ourRun = runs.find((r: any) => r.path && r.path.endsWith("android-apk-builder.yml"));
        if (ourRun) {
          runId = ourRun.id;
          break;
        }
      } catch (err) {}
      attempts++;
    }

    res.json({
      owner: username,
      repo: repoName,
      repoUrl: `https://github.com/${username}/${repoName}`,
      runId,
      branch: defaultBranch,
      isFork: false,
      detectedConfig: {
        javaVersion: finalJavaVersion,
        usesNdk: detectedUsesNdk,
        ndkVersion: detectedNdkVersion,
        buildCommand: finalBuildCommand
      }
    });

  } catch (error: any) {
    console.error("ZIP build upload error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    // Cleanup tempDir
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn("Cleanup error for /tmp:", cleanupError);
      }
    }
  }
});

// 3. Check status of a workflow run & fetch artifacts if completed
app.post("/api/build/status", async (req, res) => {
  try {
    const { owner, repo, runId } = req.body;
    const pat = req.body.pat || process.env.DEFAULT_GITHUB_PAT;

    if (!owner || !repo) {
      return res.status(400).json({ error: "Owner and repo are required" });
    }
    if (!pat) {
      return res.status(401).json({ error: "GitHub Personal Access Token (PAT) is required" });
    }

    let runDetails: any = null;

    if (runId) {
      // Get specific run
      const runRes = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${runId}`, pat);
      runDetails = await runRes.json();
    } else {
      // Get latest run
      const runsRes = await githubRequest(`/repos/${owner}/${repo}/actions/runs?event=workflow_dispatch&per_page=1`, pat);
      const runsData = await runsRes.json();
      const runs = runsData.workflow_runs || [];
      runDetails = runs.find((r: any) => r.path && r.path.endsWith("android-apk-builder.yml")) || null;
    }

    if (!runDetails) {
      return res.json({ status: "not_found" });
    }

    const result: any = {
      id: runDetails.id,
      status: runDetails.status, // queued, in_progress, completed, etc.
      conclusion: runDetails.conclusion, // success, failure, cancelled, etc.
      html_url: runDetails.html_url,
      created_at: runDetails.created_at,
      updated_at: runDetails.updated_at,
      artifacts: [],
      jobs: []
    };

    // Fetch jobs for this run to display individual step details
    if (runDetails.id) {
      try {
        const jobsRes = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${runDetails.id}/jobs`, pat);
        const jobsData = await jobsRes.json();
        result.jobs = (jobsData.jobs || []).map((j: any) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          steps: (j.steps || []).map((s: any) => ({
            name: s.name,
            status: s.status,
            conclusion: s.conclusion,
            number: s.number,
            started_at: s.started_at,
            completed_at: s.completed_at
          }))
        }));
      } catch (err) {
        console.warn("Error fetching jobs in status check:", err);
      }
    }

    // If completed and successful, find artifacts
    if (runDetails.status === "completed") {
      try {
        const artifactsRes = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${runDetails.id}/artifacts`, pat);
        const artifactsData = await artifactsRes.json();
        result.artifacts = (artifactsData.artifacts || []).map((art: any) => ({
          id: art.id,
          name: art.name,
          size_in_bytes: art.size_in_bytes,
          created_at: art.created_at
        }));
      } catch (err) {
        // Artifacts might not be loaded yet or error
      }
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Proxy artifact download redirect URL
app.post("/api/build/artifact-url", async (req, res) => {
  try {
    const { owner, repo, artifactId } = req.body;
    const pat = req.body.pat || process.env.DEFAULT_GITHUB_PAT;

    if (!owner || !repo || !artifactId) {
      return res.status(400).json({ error: "Owner, repo, and artifactId are required" });
    }
    if (!pat) {
      return res.status(401).json({ error: "GitHub Personal Access Token (PAT) is required" });
    }

    // Call the zip endpoint with redirect manual to capture the AWS S3 URL
    const response = await githubRequest(`/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, pat, {
      redirect: "manual"
    });

    // The manual redirect will return the response with the location header
    const s3Url = response.headers.get("location");
    if (!s3Url) {
      return res.status(404).json({ error: "Download URL not found in redirect location header" });
    }

    res.json({ downloadUrl: s3Url });
  } catch (error: any) {
    console.error("Artifact URL retrieval error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Proxy job log retrieval
app.post("/api/build/job-logs", async (req, res) => {
  try {
    const { owner, repo, jobId } = req.body;
    const pat = req.body.pat || process.env.DEFAULT_GITHUB_PAT;

    if (!owner || !repo || !jobId) {
      return res.status(400).json({ error: "Owner, repo, and jobId are required" });
    }
    if (!pat) {
      return res.status(401).json({ error: "GitHub Personal Access Token (PAT) is required" });
    }

    let response;
    try {
      response = await githubRequest(`/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, pat, {
        redirect: "manual"
      });
    } catch (apiError: any) {
      if (apiError.message && apiError.message.includes("(404)")) {
        return res.json({ logs: "Logs are starting up... Preparing console stream from GitHub Actions." });
      }
      throw apiError;
    }

    const s3Url = response.headers.get("location");
    if (!s3Url) {
      const text = await response.text();
      return res.json({ logs: text });
    }

    // Fetch without standard authorization header to avoid S3 rejection
    const logsRes = await fetch(s3Url);
    if (!logsRes.ok) {
      const errorText = await logsRes.text().catch(() => "");
      if (
        logsRes.status === 404 ||
        errorText.includes("BlobNotFound") ||
        errorText.includes("The specified blob does not exist") ||
        errorText.includes("NoSuchKey")
      ) {
        return res.json({ logs: "Logs are starting up... Preparing console stream from GitHub Actions." });
      }
      throw new Error(`Failed to retrieve logs: ${logsRes.statusText || logsRes.status}`);
    }

    const logsText = await logsRes.text();
    res.json({ logs: logsText });
  } catch (error: any) {
    console.error("Job logs retrieval error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend with Vite integration
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
