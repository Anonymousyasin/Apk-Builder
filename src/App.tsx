import { useState, useEffect, useRef } from "react";
import { 
  Github, 
  Cpu, 
  Settings, 
  Play, 
  CheckCircle, 
  XCircle, 
  AlertCircle, 
  Loader2, 
  Download, 
  History, 
  User, 
  RefreshCw, 
  ExternalLink, 
  Terminal, 
  ArrowRight, 
  Clock, 
  Check,
  ChevronRight,
  Info,
  Copy,
  Upload,
  FolderArchive,
  FolderGit
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface UserProfile {
  login: string;
  avatar_url: string;
  name: string | null;
  html_url: string;
}

interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  created_at: string;
}

interface JobStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at?: string;
  completed_at?: string;
}

interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: JobStep[];
}

interface BuildRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  artifacts: Artifact[];
  jobs?: Job[];
}

interface BuildHistoryItem {
  id: number;
  repoUrl: string;
  owner: string;
  repo: string;
  timestamp: string;
  status: string;
  conclusion: string | null;
  artifacts: Artifact[];
}

export default function App() {
  // Inputs
  const [pat, setPat] = useState(() => localStorage.getItem("github_pat") || "");
  const [repoUrl, setRepoUrl] = useState("https://github.com/seedhollow/R3DNETWORK");
  const [javaVersion, setJavaVersion] = useState("auto");
  const [buildCommand, setBuildCommand] = useState("auto");

  // ZIP Upload inputs
  const [buildSource, setBuildSource] = useState<"github" | "zip">("github");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Authentication state
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isValidatingToken, setIsValidatingToken] = useState(false);
  const [authError, setAuthError] = useState("");

  // Build execution state
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildError, setBuildError] = useState("");
  const [activeOwner, setActiveOwner] = useState("");
  const [activeRepo, setActiveRepo] = useState("");
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [activeRun, setActiveRun] = useState<BuildRun | null>(null);
  const [activeRepoUrl, setActiveRepoUrl] = useState("");
  const [detectedConfig, setDetectedConfig] = useState<{
    javaVersion: string;
    usesNdk: boolean;
    ndkVersion: string | null;
    buildCommand: string;
  } | null>(null);

  // Job Logs states
  const [activeJobLogs, setActiveJobLogs] = useState<string>("");
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logsError, setLogsError] = useState("");
  const [fetchedLogsJobId, setFetchedLogsJobId] = useState<number | null>(null);
  const [copiedLogs, setCopiedLogs] = useState(false);

  const handleCopyLogs = () => {
    if (!activeJobLogs) return;
    navigator.clipboard.writeText(activeJobLogs);
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
  };
  
  // Elapsed time timer
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Build steps tracking
  const [steps, setSteps] = useState([
    { id: "fork", name: "Forking / Verifying Repository", status: "idle", description: "Verifies write access or forks the repo to your account" },
    { id: "workflow", name: "Committing Build Workflow", status: "idle", description: "Injects android-apk-builder.yml into the default branch" },
    { id: "trigger", name: "Launching GitHub Action Run", status: "idle", description: "Triggers the build workflow via workflow_dispatch" },
    { id: "compile", name: "Assembling Android APK", status: "idle", description: "GitHub runner builds code with Gradle & Java" },
    { id: "artifact", name: "Generating Downloadable APK", status: "idle", description: "Prepares files & makes artifact bundle available" }
  ]);

  // History state
  const [history, setHistory] = useState<BuildHistoryItem[]>(() => {
    try {
      const stored = localStorage.getItem("build_history");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Load and validate token on startup
  useEffect(() => {
    validateToken(pat, true);
  }, []);

  // Save PAT to localStorage on change
  useEffect(() => {
    if (pat) {
      localStorage.setItem("github_pat", pat);
    } else {
      localStorage.removeItem("github_pat");
    }
  }, [pat]);

  // Save history to localStorage
  useEffect(() => {
    localStorage.setItem("build_history", JSON.stringify(history));
  }, [history]);

  // Track active run compilation duration
  useEffect(() => {
    if (isBuilding && (activeRun?.status === "in_progress" || activeRun?.status === "queued")) {
      if (!timerRef.current) {
        timerRef.current = setInterval(() => {
          setElapsedTime((prev) => prev + 1);
        }, 1000);
      }
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isBuilding, activeRun?.status]);

  const fetchJobLogs = async (jobId: number, silent = false) => {
    if (!silent) {
      setIsLoadingLogs(true);
    }
    setLogsError("");
    try {
      const res = await fetch("/api/build/job-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: activeOwner,
          repo: activeRepo,
          jobId,
          pat: pat || undefined
        })
      });

      if (!res.ok) {
        throw new Error("Failed to fetch logs from server");
      }

      const data = await res.json();
      setActiveJobLogs(data.logs || "No logs available for this job.");
      setFetchedLogsJobId(jobId);
    } catch (err: any) {
      if (!silent) {
        setLogsError(err.message || "Failed to load logs.");
      }
    } finally {
      if (!silent) {
        setIsLoadingLogs(false);
      }
    }
  };

  // Handle polling for active builds and live log streaming
  useEffect(() => {
    let pollingInterval: NodeJS.Timeout | null = null;

    if (isBuilding && activeOwner && activeRepo && activeRunId) {
      // Poll every 5 seconds
      pollingInterval = setInterval(async () => {
        try {
          const res = await fetch("/api/build/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              owner: activeOwner,
              repo: activeRepo,
              runId: activeRunId,
              pat: pat || undefined // server will use default if empty
            })
          });

          if (!res.ok) {
            throw new Error(`Failed to check build status: ${res.statusText}`);
          }

          const run: BuildRun = await res.json();
          setActiveRun(run);

          // Stream live logs in real-time as the build compiles
          if (run.jobs && run.jobs.length > 0) {
            const mainJob = run.jobs[0];
            fetchJobLogs(mainJob.id, true);
          }

          // Update the step statuses dynamically
          setSteps(prevSteps => {
            return prevSteps.map(step => {
              if (step.id === "fork" || step.id === "workflow" || step.id === "trigger") {
                return { ...step, status: "success" };
              }
              if (step.id === "compile") {
                if (run.status === "completed") {
                  return { ...step, status: run.conclusion === "success" ? "success" : "error" };
                }
                return { ...step, status: "running" };
              }
              if (step.id === "artifact") {
                if (run.status === "completed") {
                  if (run.conclusion === "success") {
                    return { ...step, status: run.artifacts && run.artifacts.length > 0 ? "success" : "running" };
                  }
                  return { ...step, status: "idle" };
                }
                return { ...step, status: "pending" };
              }
              return step;
            });
          });

          // Check if finalized
          if (run.status === "completed") {
            const success = run.conclusion === "success";
            
            // If success, wait until artifact is present in the list
            if (success && run.artifacts && run.artifacts.length > 0) {
              stopBuilding(run);
              addToHistory(activeOwner, activeRepo, run);
            } else if (!success) {
              stopBuilding(run);
              addToHistory(activeOwner, activeRepo, run);
            }
          }
        } catch (err: any) {
          if (err.message && err.message.includes("Failed to fetch")) {
            console.warn("Build status polling temporarily offline, retrying shortly...");
          } else {
            console.error("Polling error:", err);
          }
        }
      }, 5000);
    }

    return () => {
      if (pollingInterval) clearInterval(pollingInterval);
    };
  }, [isBuilding, activeOwner, activeRepo, activeRunId, pat]);

  // Automatically trigger a non-silent fetch when the first job finishes, to make sure the terminal shows complete/final state beautifully
  useEffect(() => {
    if (activeRun?.jobs && activeRun.jobs.length > 0) {
      const mainJob = activeRun.jobs[0];
      if (
        (mainJob.status === "completed" || activeRun.status === "completed") &&
        fetchedLogsJobId !== mainJob.id &&
        !isLoadingLogs
      ) {
        fetchJobLogs(mainJob.id, false);
      }
    }
  }, [activeRun?.jobs, fetchedLogsJobId, isLoadingLogs]);

  const validateToken = async (tokenToValidate: string, silent = false) => {
    if (!silent) {
      setIsValidatingToken(true);
      setAuthError("");
    }
    try {
      const res = await fetch("/api/github/user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pat: tokenToValidate || undefined })
      });

      if (!res.ok) {
        throw new Error("Failed to authenticate token");
      }

      const data = await res.json();
      setUserProfile(data);
    } catch (err: any) {
      if (!silent) {
        setAuthError(err.message || "Could not validate your Personal Access Token. Please check your token permissions.");
      }
      setUserProfile(null);
    } finally {
      if (!silent) {
        setIsValidatingToken(false);
      }
    }
  };

  const updateStepStatus = (id: string, status: "idle" | "pending" | "running" | "success" | "error") => {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, status } : s));
  };

  const handleStartBuild = async () => {
    setBuildError("");
    setIsBuilding(true);
    setElapsedTime(0);
    setActiveRun(null);
    setDetectedConfig(null);
    setActiveJobLogs("");
    setLogsError("");
    setFetchedLogsJobId(null);
    
    // Reset steps
    setSteps([
      { id: "fork", name: buildSource === "zip" ? "Creating & Pushing Repository" : "Forking / Verifying Repository", status: "running", description: buildSource === "zip" ? "Creates a new private repo and pushes extracted project code" : "Verifies write access or forks the repo to your account" },
      { id: "workflow", name: "Committing Build Workflow", status: "pending", description: "Injects android-apk-builder.yml into the default branch" },
      { id: "trigger", name: "Launching GitHub Action Run", status: "pending", description: "Triggers the build workflow via workflow_dispatch" },
      { id: "compile", name: "Assembling Android APK", status: "pending", description: "GitHub runner builds code with Gradle & Java" },
      { id: "artifact", name: "Generating Downloadable APK", status: "pending", description: "Prepares files & makes artifact bundle available" }
    ]);

    try {
      let triggerRes;
      if (buildSource === "zip") {
        if (!zipFile) {
          throw new Error("Please select a valid ZIP file containing your Android project.");
        }
        const formData = new FormData();
        formData.append("zip", zipFile);
        formData.append("javaVersion", javaVersion);
        formData.append("buildCommand", buildCommand);
        if (pat) {
          formData.append("pat", pat);
        }

        triggerRes = await fetch("/api/build/upload-zip", {
          method: "POST",
          body: formData
        });
      } else {
        triggerRes = await fetch("/api/build/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoUrl,
            javaVersion,
            buildCommand,
            pat: pat || undefined
          })
        });
      }

      if (!triggerRes.ok) {
        const errorData = await triggerRes.json();
        throw new Error(errorData.error || "Failed to trigger the build.");
      }

      const triggerData = await triggerRes.json();
      const { owner, repo, runId, repoUrl: returnedRepoUrl, detectedConfig: returnedConfig } = triggerData;

      setActiveOwner(owner);
      setActiveRepo(repo);
      setActiveRunId(runId);
      setActiveRepoUrl(returnedRepoUrl || repoUrl);
      if (returnedConfig) {
        setDetectedConfig(returnedConfig);
      }

      // Instantly mark fork as complete and workflow as completed, and launch trigger running
      updateStepStatus("fork", "success");
      updateStepStatus("workflow", "success");
      updateStepStatus("trigger", "running");

      // Give actions dispatch a second to process
      setTimeout(() => {
        updateStepStatus("trigger", "success");
        updateStepStatus("compile", "running");
      }, 3000);

    } catch (err: any) {
      setBuildError(err.message || "An unexpected error occurred during initialization.");
      setIsBuilding(false);
      // Mark current running step as error
      setSteps(prev => prev.map(s => s.status === "running" ? { ...s, status: "error" } : s));
    }
  };

  const stopBuilding = (runDetails: BuildRun) => {
    setIsBuilding(false);
    if (runDetails.conclusion === "success" && runDetails.artifacts && runDetails.artifacts.length > 0) {
      setSteps(prev => prev.map(s => s.id === "artifact" ? { ...s, status: "success" } : s));
    }
  };

  const addToHistory = (owner: string, repo: string, run: BuildRun) => {
    const newItem: BuildHistoryItem = {
      id: run.id,
      repoUrl: activeRepoUrl || repoUrl,
      owner,
      repo,
      timestamp: new Date().toLocaleString(),
      status: run.status,
      conclusion: run.conclusion,
      artifacts: run.artifacts
    };
    setHistory(prev => [newItem, ...prev.filter(item => item.id !== run.id)].slice(0, 10));
  };

  const handleDownloadArtifact = async (owner: string, repo: string, artifactId: number) => {
    try {
      const res = await fetch("/api/build/artifact-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          repo,
          artifactId,
          pat: pat || undefined
        })
      });

      if (!res.ok) {
        throw new Error("Could not retrieve artifact download URL");
      }

      const data = await res.json();
      if (data.downloadUrl) {
        window.location.href = data.downloadUrl;
      }
    } catch (err: any) {
      alert(`Download failed: ${err.message}`);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const dm = 2;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem("build_history");
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans antialiased selection:bg-indigo-100 selection:text-indigo-900">
      {/* Header */}
      <header className="border-b border-slate-200/80 bg-white sticky top-0 z-50 shadow-xs">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center text-white">
              <Cpu className="w-5.5 h-5.5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">GitHub APK Builder</h1>
              <p className="text-xs text-slate-500">Automate Android compiles via GitHub Actions</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2 text-xs text-slate-400 border border-slate-200/80 rounded-lg px-3 py-1.5 bg-slate-50">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Cloud Proxy Active
          </div>
        </div>
      </header>

      {/* Main Grid Layout */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Left Column - Configuration & Credentials */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            
            {/* GitHub PAT Card */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Github className="w-5 h-5 text-slate-700" />
                <h2 className="font-semibold text-sm tracking-tight text-slate-900">GitHub Authentication</h2>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Provide a GitHub Personal Access Token (PAT) with <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-700">repo</code> and <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-700">workflow</code> permissions. If left blank, the app will use the pre-configured default PAT.
              </p>

              <div className="flex flex-col gap-2">
                <label className="text-xs font-semibold text-slate-600">Personal Access Token (PAT)</label>
                <div className="relative flex items-center">
                  <input
                    type="password"
                    placeholder="ghp_************************************"
                    className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-slate-900/10 focus:border-slate-900 outline-none transition-all placeholder:text-slate-400 font-mono"
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={() => validateToken(pat)}
                  disabled={isValidatingToken}
                  className="flex-1 flex items-center justify-center gap-2 text-xs font-medium border border-slate-200 hover:bg-slate-50 active:bg-slate-100/80 disabled:bg-slate-50 disabled:text-slate-400 text-slate-700 rounded-xl py-2.5 cursor-pointer transition-all"
                >
                  {isValidatingToken ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Validating...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5" />
                      Connect & Validate
                    </>
                  )}
                </button>
              </div>

              {/* Connected State Info */}
              {userProfile ? (
                <div className="border border-emerald-100 bg-emerald-50/40 rounded-xl p-3 flex items-center gap-3">
                  <img 
                    src={userProfile.avatar_url} 
                    alt={userProfile.login} 
                    className="w-8 h-8 rounded-full border border-emerald-200/80"
                    referrerPolicy="no-referrer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                      {userProfile.name || userProfile.login}
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    </div>
                    <a 
                      href={userProfile.html_url} 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="text-[11px] text-slate-500 hover:text-slate-900 hover:underline flex items-center gap-0.5"
                    >
                      @{userProfile.login}
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                  <span className="text-[10px] bg-emerald-100 text-emerald-800 font-medium px-2 py-0.5 rounded-full">
                    Token Active
                  </span>
                </div>
              ) : pat === "" ? (
                <div className="border border-amber-100 bg-amber-50/30 rounded-xl p-3 flex items-start gap-2.5">
                  <Info className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-[11px] text-amber-800 leading-normal">
                    <strong>Using Default pre-configured PAT</strong>. You can run builds directly, and the system will automatically fork repos to the default testing user profile.
                  </div>
                </div>
              ) : null}

              {authError && (
                <div className="border border-red-100 bg-red-50/40 rounded-xl p-3 flex items-start gap-2 text-xs text-red-700">
                  <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <span>{authError}</span>
                </div>
              )}
            </div>

            {/* Build Settings Card */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs flex flex-col gap-5">
              <div className="flex items-center gap-2 justify-between">
                <div className="flex items-center gap-2">
                  <Settings className="w-5 h-5 text-slate-700" />
                  <h2 className="font-semibold text-sm tracking-tight text-slate-900">Build Target & Environment</h2>
                </div>
              </div>

              {/* Build Source Toggle Tabs */}
              <div className="flex border-b border-slate-100 pb-1">
                <button
                  type="button"
                  onClick={() => setBuildSource("github")}
                  className={`flex items-center gap-2 pb-2.5 px-3 text-xs font-semibold border-b-2 transition-all cursor-pointer ${
                    buildSource === "github"
                      ? "border-slate-900 text-slate-900"
                      : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
                >
                  <FolderGit className="w-3.5 h-3.5" />
                  GitHub Repository
                </button>
                <button
                  type="button"
                  onClick={() => setBuildSource("zip")}
                  className={`flex items-center gap-2 pb-2.5 px-3 text-xs font-semibold border-b-2 transition-all cursor-pointer ${
                    buildSource === "zip"
                      ? "border-slate-900 text-slate-900"
                      : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
                >
                  <FolderArchive className="w-3.5 h-3.5" />
                  ZIP Project Upload
                </button>
              </div>

              {buildSource === "github" ? (
                /* Repo URL Input */
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-slate-600 flex items-center justify-between">
                    <span>Android App GitHub Repository</span>
                    <button 
                      onClick={() => setRepoUrl("https://github.com/seedhollow/R3DNETWORK")}
                      className="text-[10px] text-indigo-600 hover:text-indigo-800 hover:underline font-medium cursor-pointer"
                    >
                      Reset to R3DNETWORK
                    </button>
                  </label>
                  <input
                    type="text"
                    placeholder="https://github.com/owner/repository"
                    className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-slate-900/10 focus:border-slate-900 outline-none transition-all placeholder:text-slate-400 font-mono"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                  />
                </div>
              ) : (
                /* ZIP Upload Input */
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-slate-600 flex items-center justify-between">
                    <span>Upload Android Project ZIP</span>
                    <span className="text-[10px] text-slate-400 font-medium">Max 100MB</span>
                  </label>
                  
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragOver(true);
                    }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragOver(false);
                      const file = e.dataTransfer.files[0];
                      if (file && (file.type === "application/zip" || file.name.endsWith(".zip"))) {
                        setZipFile(file);
                      }
                    }}
                    className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center gap-3 transition-all cursor-pointer text-center relative ${
                      isDragOver
                        ? "border-slate-900 bg-slate-50/50"
                        : zipFile
                        ? "border-emerald-200 bg-emerald-50/20"
                        : "border-slate-200 hover:border-slate-300 bg-slate-50/30"
                    }`}
                  >
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          setZipFile(file);
                        }
                      }}
                    />
                    
                    {zipFile ? (
                      <>
                        <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600">
                          <FolderArchive className="w-5 h-5" />
                        </div>
                        <div className="flex flex-col gap-0.5 max-w-[85%]">
                          <span className="text-xs font-semibold text-slate-800 truncate block">
                            {zipFile.name}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {(zipFile.size / (1024 * 1024)).toFixed(2)} MB • Ready to build
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setZipFile(null);
                          }}
                          className="text-[10px] font-semibold text-red-500 hover:text-red-700 hover:underline cursor-pointer z-10"
                        >
                          Remove file
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-500">
                          <Upload className="w-5 h-5" />
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-semibold text-slate-700">
                            Drag & drop or click to upload ZIP
                          </span>
                          <span className="text-[10px] text-slate-400">
                            ZIP file containing an Android Studio project structure
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Advanced Environment Row */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
                <div className="sm:col-span-4 flex flex-col gap-2">
                  <label className="text-xs font-semibold text-slate-600">Java SDK</label>
                  <select
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-3 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-slate-900/10 focus:border-slate-900 outline-none transition-all"
                    value={javaVersion}
                    onChange={(e) => setJavaVersion(e.target.value)}
                  >
                    <option value="auto">Auto-detect (JDK 17/21)</option>
                    <option value="17">JDK 17 (Recommended Minimum)</option>
                    <option value="21">JDK 21 (Modern)</option>
                  </select>
                </div>

                <div className="sm:col-span-8 flex flex-col gap-2">
                  <label className="text-xs font-semibold text-slate-600">Assemble Task Command</label>
                  <input
                    type="text"
                    className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-slate-900/10 focus:border-slate-900 outline-none transition-all font-mono"
                    placeholder="auto (or e.g. ./gradlew assembleDebug)"
                    value={buildCommand}
                    onChange={(e) => setBuildCommand(e.target.value)}
                  />
                </div>
              </div>

              {/* Info Tips */}
              <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-100 flex gap-3 text-xs text-slate-500 leading-normal">
                <Info className="w-4.5 h-4.5 text-slate-400 mt-0.5 shrink-0" />
                <div>
                  <strong>How this works:</strong> If you don't own the repository, the app forks it automatically to your account, commits the workflow, triggers GitHub Actions, and monitors compilation in real time to fetch the APK.
                </div>
              </div>

              {/* Submit Trigger Action */}
              <button
                type="button"
                onClick={handleStartBuild}
                disabled={isBuilding || (buildSource === "github" ? !repoUrl : !zipFile)}
                className="w-full flex items-center justify-center gap-2.5 text-sm font-semibold bg-slate-900 hover:bg-slate-800 text-white disabled:bg-slate-100 disabled:text-slate-400 rounded-xl py-3.5 shadow-sm hover:shadow-md cursor-pointer transition-all transform active:scale-[0.99]"
              >
                {isBuilding ? (
                  <>
                    <Loader2 className="w-4.5 h-4.5 animate-spin" />
                    Building & Compiling APK...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-white" />
                    Trigger Android Build
                  </>
                )}
              </button>
            </div>

          </div>

          {/* Right Column - Execution Monitor & History */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            
            {/* Active Run Monitor Container */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs min-h-[400px] flex flex-col">
              
              {isBuilding || activeRun || buildError ? (
                <div className="flex flex-col flex-1 gap-6">
                  {/* Active Header */}
                  <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                    <div className="flex flex-col">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Active Pipeline</span>
                      <h3 className="font-semibold text-base text-slate-900 leading-tight">
                        {activeRepo || "Initializing..."}
                      </h3>
                      {detectedConfig && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          <span className="text-[10px] font-semibold bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md flex items-center gap-1">
                            JDK: {detectedConfig.javaVersion}
                          </span>
                          {detectedConfig.usesNdk && (
                            <span className="text-[10px] font-semibold bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-md flex items-center gap-1 border border-indigo-100">
                              NDK: {detectedConfig.ndkVersion || "auto"}
                            </span>
                          )}
                          <span className="text-[10px] font-semibold bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md flex items-center gap-1 font-mono">
                            Cmd: {detectedConfig.buildCommand}
                          </span>
                        </div>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2.5">
                      {activeRun?.status === "in_progress" || activeRun?.status === "queued" || isBuilding && !activeRun ? (
                        <div className="flex items-center gap-2 text-xs font-semibold text-indigo-700 bg-indigo-50/70 border border-indigo-100 px-3 py-1.5 rounded-full">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>{formatTime(elapsedTime)}</span>
                        </div>
                      ) : buildError ? (
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-red-800 bg-red-50 border border-red-100 px-3 py-1.5 rounded-full">
                          <XCircle className="w-3.5 h-3.5 text-red-600" />
                          <span>Initialization Failed</span>
                        </div>
                      ) : activeRun?.conclusion === "success" ? (
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-100 px-3 py-1.5 rounded-full">
                          <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                          <span>Build Succeeded</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-red-800 bg-red-50 border border-red-100 px-3 py-1.5 rounded-full">
                          <XCircle className="w-3.5 h-3.5 text-red-600" />
                          <span>Build Failed</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Step Tracker Timeline */}
                  <div className="flex flex-col gap-4 py-2">
                    {steps.map((step, idx) => {
                      const isLast = idx === steps.length - 1;
                      
                      return (
                        <div key={step.id} className="relative flex gap-4">
                          {/* Line */}
                          {!isLast && (
                            <div className="absolute left-[13px] top-[26px] bottom-[-20px] w-[2px] bg-slate-100">
                              <div 
                                className={`h-full w-full transition-all duration-500 ${
                                  step.status === "success" ? "bg-emerald-500" : ""
                                }`} 
                              />
                            </div>
                          )}

                          {/* Node Bullet Icon */}
                          <div className="z-10 mt-1">
                            {step.status === "success" ? (
                              <div className="w-7 h-7 rounded-full bg-emerald-100 border border-emerald-200 flex items-center justify-center text-emerald-700">
                                <Check className="w-4 h-4 stroke-[3px]" />
                              </div>
                            ) : step.status === "running" ? (
                              <div className="w-7 h-7 rounded-full bg-indigo-50 border border-indigo-300 flex items-center justify-center text-indigo-600">
                                <Loader2 className="w-4 h-4 animate-spin" />
                              </div>
                            ) : step.status === "error" ? (
                              <div className="w-7 h-7 rounded-full bg-red-100 border border-red-200 flex items-center justify-center text-red-700">
                                <XCircle className="w-4 h-4 stroke-[3px]" />
                              </div>
                            ) : step.status === "pending" ? (
                              <div className="w-7 h-7 rounded-full bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-400">
                                <Clock className="w-3.5 h-3.5" />
                              </div>
                            ) : (
                              <div className="w-7 h-7 rounded-full bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-300">
                                <div className="w-1.5 h-1.5 rounded-full bg-slate-300" />
                              </div>
                            )}
                          </div>

                          {/* Step Copy */}
                          <div className="flex-1 flex flex-col gap-0.5">
                            <span className="text-sm font-semibold text-slate-800 leading-none mt-1.5 flex items-center gap-1.5">
                              {step.name}
                              {step.status === "running" && (
                                <span className="text-[10px] bg-indigo-100 text-indigo-800 font-medium px-2 py-0.5 rounded-full uppercase tracking-wider animate-pulse">
                                  In Progress
                                </span>
                              )}
                            </span>
                            <span className="text-xs text-slate-400 leading-relaxed">
                              {step.description}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Runner Jobs & Console Logs */}
                  {activeRun?.jobs && activeRun.jobs.length > 0 && (
                    <div className="border border-slate-200/80 rounded-2xl overflow-hidden bg-slate-50 flex flex-col my-1">
                      <div className="bg-slate-100/80 px-4 py-3 flex items-center justify-between border-b border-slate-200/60">
                        <div className="flex items-center gap-2">
                          <Terminal className="w-4 h-4 text-slate-700" />
                          <span className="text-xs font-semibold text-slate-800">Runner Jobs & Steps</span>
                        </div>
                        {activeRun.jobs[0] && (
                          <button
                            onClick={() => fetchJobLogs(activeRun.jobs![0].id)}
                            disabled={isLoadingLogs}
                            className="text-[10px] text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                          >
                            {isLoadingLogs ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            <span>Refresh Logs</span>
                          </button>
                        )}
                      </div>

                      <div className="p-4 flex flex-col gap-3">
                        {activeRun.jobs.map((job) => (
                          <div key={job.id} className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                              <span>Job: {job.name}</span>
                              <span className={`text-[9px] px-2 py-0.5 rounded-md font-medium ${
                                job.status === "completed" 
                                  ? (job.conclusion === "success" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800")
                                  : "bg-indigo-100 text-indigo-800 animate-pulse"
                              }`}>
                                {job.conclusion || job.status}
                              </span>
                            </div>

                            <div className="pl-3.5 border-l border-slate-200 flex flex-col gap-2">
                              {job.steps.map((step) => (
                                <div key={step.number} className="flex items-center justify-between gap-4 text-[11px] text-slate-600">
                                  <span className="flex items-center gap-2">
                                    <span className={`w-1.5 h-1.5 rounded-full ${
                                      step.status === "completed"
                                        ? (step.conclusion === "success" ? "bg-emerald-500" : "bg-red-500")
                                        : "bg-indigo-500"
                                    }`} />
                                    <span className="font-medium text-slate-700">{step.name}</span>
                                  </span>
                                  <span className={`text-[10px] font-semibold ${
                                    step.status === "completed"
                                      ? (step.conclusion === "success" ? "text-emerald-600" : "text-red-600")
                                      : "text-indigo-600"
                                  }`}>
                                    {step.conclusion || step.status}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Raw Terminal Output */}
                      {(activeJobLogs || isLoadingLogs || logsError) && (
                        <div className="border-t border-slate-200 bg-slate-900 text-slate-100 p-4 font-mono text-xs flex flex-col gap-2.5">
                          <div className="flex items-center justify-between text-[10px] text-slate-400 border-b border-slate-800 pb-2">
                            <div className="flex items-center gap-3">
                              <span>CONSOLE LOG OUTPUT</span>
                              {activeJobLogs && (
                                <button
                                  onClick={handleCopyLogs}
                                  className="text-indigo-400 hover:text-indigo-300 font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                                >
                                  {copiedLogs ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                                  <span>{copiedLogs ? "Copied!" : "Copy Logs"}</span>
                                </button>
                              )}
                            </div>
                            {isLoadingLogs ? (
                              <span className="flex items-center gap-1.5 text-indigo-400">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Stream loading...
                              </span>
                            ) : (
                              <span>{activeJobLogs ? activeJobLogs.split("\n").length : 0} lines</span>
                            )}
                          </div>
                          {isLoadingLogs ? (
                            <div className="py-10 flex flex-col items-center justify-center gap-2 text-slate-400">
                              <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
                              <span className="text-[10px]">Downloading compilation output from GitHub storage...</span>
                            </div>
                          ) : logsError ? (
                            <div className="text-red-400 py-4 text-center text-[11px]">{logsError}</div>
                          ) : (
                            <pre className="max-h-[350px] overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed select-text pr-2 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
                              {activeJobLogs}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Errors Block */}
                  {buildError && (
                    <div className="border border-red-100 bg-red-50/40 rounded-xl p-4 flex items-start gap-3 text-xs text-red-700 mt-2">
                      <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
                      <div className="flex flex-col gap-1">
                        <strong className="font-semibold">Pipeline Execution Interrupted</strong>
                        <span>{buildError}</span>
                      </div>
                    </div>
                  )}

                  {/* Actions / Artifact Box */}
                  <div className="mt-auto pt-6 border-t border-slate-100 flex flex-col gap-3">
                    
                    {activeRun && (
                      <a 
                        href={activeRun.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl py-3 text-xs font-semibold transition-all"
                      >
                        <Terminal className="w-4 h-4 text-slate-500" />
                        <span>Stream Live Console Logs on GitHub</span>
                        <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
                      </a>
                    )}

                    {activeRun?.status === "completed" && activeRun.conclusion === "success" && (
                      <div className="bg-emerald-50/50 border border-emerald-100 rounded-xl p-4 flex flex-col gap-3.5">
                        <div className="flex items-start gap-3">
                          <CheckCircle className="w-5.5 h-5.5 text-emerald-600 shrink-0 mt-0.5" />
                          <div className="flex flex-col gap-0.5">
                            <h4 className="text-sm font-semibold text-emerald-900 leading-none">APK Compiled Successfully!</h4>
                            <p className="text-xs text-slate-500">
                              Your artifact package has been processed and is ready for local deployment.
                            </p>
                          </div>
                        </div>

                        {activeRun.artifacts && activeRun.artifacts.length > 0 ? (
                          <div className="flex flex-col gap-2">
                            {activeRun.artifacts.map((art) => (
                              <button
                                key={art.id}
                                onClick={() => handleDownloadArtifact(activeOwner, activeRepo, art.id)}
                                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-between rounded-xl px-4 py-3.5 font-semibold text-xs transition-all shadow-xs cursor-pointer hover:shadow-sm"
                              >
                                <span className="flex items-center gap-2">
                                  <Download className="w-4 h-4" />
                                  <span>{art.name}.zip</span>
                                  <span className="text-[10px] text-emerald-100">({formatSize(art.size_in_bytes)})</span>
                                </span>
                                <span className="text-[10px] bg-emerald-500 text-white px-2 py-0.5 rounded-md font-medium uppercase tracking-wider flex items-center gap-1">
                                  Extract APK
                                  <ChevronRight className="w-3 h-3" />
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-500 bg-white border border-slate-200/80 rounded-lg p-2.5 flex items-center justify-center gap-2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Waiting for S3 links to sync...
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center py-12 text-center my-auto">
                  <div className="w-16 h-16 rounded-full bg-slate-50 border border-slate-200/50 flex items-center justify-center text-slate-400 mb-4 shadow-2xs">
                    <Cpu className="w-7 h-7 stroke-[1.5]" />
                  </div>
                  <h3 className="font-semibold text-slate-900 text-base leading-tight">No Active Pipeline running</h3>
                  <p className="text-xs text-slate-400 max-w-[340px] mt-2 leading-relaxed">
                    Configure your repository URL, Java version, and assembly task settings on the left, then trigger a build to initialize the execution pipeline.
                  </p>
                </div>
              )}

            </div>

            {/* Run History List */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <History className="w-5 h-5 text-slate-700" />
                  <h2 className="font-semibold text-sm tracking-tight text-slate-900">Build History (Cached Runs)</h2>
                </div>
                {history.length > 0 && (
                  <button 
                    onClick={clearHistory}
                    className="text-[10px] text-slate-400 hover:text-slate-800 font-medium cursor-pointer transition-colors"
                  >
                    Clear History
                  </button>
                )}
              </div>

              {history.length > 0 ? (
                <div className="flex flex-col divide-y divide-slate-100 max-h-[250px] overflow-y-auto pr-1">
                  {history.map((item) => (
                    <div key={item.id} className="py-3 flex items-center justify-between gap-4 text-xs">
                      <div className="flex flex-col gap-1 min-w-0">
                        <span className="font-semibold text-slate-900 truncate">
                          {item.owner}/{item.repo}
                        </span>
                        <span className="text-[10px] text-slate-400 flex items-center gap-1.5">
                          <span>Run ID: {item.id}</span>
                          <span>•</span>
                          <span>{item.timestamp}</span>
                        </span>
                      </div>

                      <div className="flex items-center gap-3">
                        {item.conclusion === "success" ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">
                            <CheckCircle className="w-3 h-3" />
                            <span>Passed</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-700 bg-red-50 border border-red-100 px-2 py-0.5 rounded-full">
                            <XCircle className="w-3 h-3" />
                            <span>Failed</span>
                          </span>
                        )}

                        {item.conclusion === "success" && item.artifacts && item.artifacts.length > 0 ? (
                          <button
                            onClick={() => handleDownloadArtifact(item.owner, item.repo, item.artifacts[0].id)}
                            className="bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1 text-[11px] transition-all cursor-pointer"
                          >
                            <Download className="w-3 h-3" />
                            Download
                          </button>
                        ) : (
                          <span className="text-[10px] text-slate-400">No APK</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-xs text-slate-400">
                  No previous compiles logged in local storage.
                </div>
              )}
            </div>

          </div>

        </div>
      </main>
    </div>
  );
}
