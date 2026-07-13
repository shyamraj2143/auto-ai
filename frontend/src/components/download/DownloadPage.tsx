import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileText,
  Lock,
  MessageSquare,
  Smartphone,
  Upload,
  Zap
} from "lucide-react";
import { api, resolveApkDownloadUrl } from "../../api/client";
import type { ApkRelease, ApkStats } from "../../types";
import { LogoIcon } from "../brand/LogoIcon";
import { FishAnimationToggleButton } from "../layout/FishAnimationToggleButton";
import { ThemeToggleButton } from "../layout/ThemeToggleButton";

const screenshots = [
  { title: "Memory chat", lines: ["Project context loaded", "Tone profile active", "Sources ready"] },
  { title: "Research mode", lines: ["Searching the web", "6 ranked sources", "Cited answer"] },
  { title: "Document flow", lines: ["PDF indexed", "Summary prepared", "Chat history synced"] }
];

const features = [
  "Same Auto-AI account and authentication",
  "Shared memory, chat history, settings, and uploads",
  "Web search with Tavily primary and Serper fallback",
  "Voice, image analysis, documents, and citations"
];

function formatBytes(bytes?: number) {
  if (!bytes) return "Pending release";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "Pending";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function absoluteDownloadUrl() {
  return resolveApkDownloadUrl();
}

export function DownloadPage() {
  const [latest, setLatest] = useState<ApkRelease | null>(null);
  const [versions, setVersions] = useState<ApkRelease[]>([]);
  const [stats, setStats] = useState<ApkStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const buildVersion = import.meta.env.VITE_BUILD_VERSION ?? "dev";
  const downloadUrl = useMemo(() => absoluteDownloadUrl(), []);

  async function downloadLatestApk() {
    const release = latest;
    let countedRelease = release;
    if (release) {
      try {
        const updatedRelease = await api.countApkDownload({ id: release.id });
        countedRelease = updatedRelease;
        setLatest(updatedRelease);
        setVersions((current) => current.map((item) => (item.id === updatedRelease.id ? updatedRelease : item)));
        setStats((current) => current && {
          ...current,
          latest: updatedRelease,
          total_downloads: current.total_downloads + 1,
          downloads_by_version: {
            ...current.downloads_by_version,
            [updatedRelease.version_name]: updatedRelease.download_count
          }
        });
      } catch {
        countedRelease = release;
      }
    }
    window.location.href = resolveApkDownloadUrl(countedRelease, Boolean(countedRelease));
  }

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const [release, releaseList, releaseStats] = await Promise.all([
          api.latestApk(),
          api.apkVersions(),
          api.apkStats()
        ]);
        if (!active) return;
        setLatest(release);
        setVersions(releaseList);
        setStats(releaseStats);
        setError("");
      } catch (requestError) {
        if (!active) return;
        setError(requestError instanceof Error ? requestError.message : "APK metadata is unavailable.");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="download-page">
      <header className="download-nav">
        <Link className="brand-mark" to="/">
          <span className="brand-icon"><LogoIcon /></span>
          Auto-AI
        </Link>
        <div className="nav-actions">
          <FishAnimationToggleButton />
          <Link className="btn-secondary" to="/">
            <ArrowLeft size={16} />
            Home
          </Link>
          <ThemeToggleButton />
        </div>
      </header>

      <main>
        <section className="download-hero">
          <div className="download-copy">
            <p className="hero-kicker"><Smartphone size={14} /> Android APK</p>
            <h1>Auto-AI Mobile</h1>
            <p className="hero-subtitle">
              Install Auto-AI on Android with the same backend, account, memory, chat history, uploads, settings, and source-grounded answers as the website.
            </p>
            <div className="download-actions">
              <button className="btn-primary h-12 px-5" type="button" onClick={downloadLatestApk}>
                <Download size={18} />
                Download Auto-AI APK
              </button>
              <span className="download-version">
                {latest ? `Version ${latest.version_name} (${latest.version_code})` : loading ? "Checking latest version" : `Build ${buildVersion}`}
              </span>
            </div>
          </div>

          <div className="app-device-stage" aria-label="Auto-AI Android app preview">
            <div className="device-phone device-phone-main">
              <div className="device-speaker" />
              <div className="device-screen">
                <div className="device-topline"><LogoIcon className="app-logo app-logo-inline" /> Auto-AI</div>
                <div className="device-message user">Search the latest model news.</div>
                <div className="device-message ai">Searching the web...</div>
                <div className="device-sources">
                  <span>S1</span><span>S2</span><span>S3</span>
                </div>
                <div className="device-composer">Message Auto-AI <Zap size={13} /></div>
              </div>
            </div>
            <div className="download-qr">
              <QRCodeSVG value={downloadUrl} size={118} bgColor="transparent" fgColor="#e0f2fe" />
              <span>Scan to download</span>
            </div>
          </div>
        </section>

        <section className="download-section">
          <div className="download-meta-grid">
            <article>
              <Smartphone size={18} />
              <span>Latest version</span>
              <strong>{latest?.version_name ?? "Pending"}</strong>
            </article>
            <article>
              <Upload size={18} />
              <span>Version code</span>
              <strong>{latest?.version_code ?? 0}</strong>
            </article>
            <article>
              <Download size={18} />
              <span>Downloads</span>
              <strong>{stats?.total_downloads?.toLocaleString() ?? latest?.download_count?.toLocaleString() ?? "0"}</strong>
            </article>
            <article>
              <FileText size={18} />
              <span>Released</span>
              <strong>{formatDateTime(latest?.released_at ?? latest?.release_date)}</strong>
            </article>
            <article>
              <CheckCircle2 size={18} />
              <span>Last updated</span>
              <strong>{formatDateTime(latest?.updated_at)}</strong>
            </article>
            <article>
              <Lock size={18} />
              <span>APK size</span>
              <strong>{formatBytes(latest?.file_size)}</strong>
            </article>
            <article>
              <CheckCircle2 size={18} />
              <span>Requires</span>
              <strong>{latest?.min_android_version ?? "Android 7.0"}</strong>
            </article>
          </div>
        </section>

        <section className="download-section download-two-col">
          <div>
            <p className="hero-kicker">Preview</p>
            <div className="screenshot-carousel">
              {screenshots.map((shot) => (
                <article key={shot.title} className="screenshot-card">
                  <div className="screenshot-header"><MessageSquare size={15} /> {shot.title}</div>
                  {shot.lines.map((line) => <span key={line}>{line}</span>)}
                </article>
              ))}
            </div>
          </div>
          <div>
            <p className="hero-kicker">Included</p>
            <div className="download-feature-list">
              {features.map((feature) => (
                <span key={feature}><CheckCircle2 size={15} /> {feature}</span>
              ))}
            </div>
          </div>
        </section>

        <section className="download-section download-two-col">
          <div className="release-panel">
            <div className="section-heading-left">
              <p className="hero-kicker"><FileText size={14} /> Release Notes</p>
              <h2>{latest ? `Version ${latest.version_name}` : `Build ${buildVersion}`}</h2>
            </div>
            {error && <p className="download-error">{error}</p>}
            <p className="text-sm text-slate-300">
              Released {formatDateTime(latest?.released_at ?? latest?.release_date)} - Updated {formatDateTime(latest?.updated_at)}
            </p>
            {latest?.changelog && <p className="mobile-changelog">{latest.changelog}</p>}
            {(latest?.release_notes?.length ? latest.release_notes : ["Release notes will appear after the first APK upload."]).map((note) => (
              <span key={note} className="release-note"><CheckCircle2 size={15} /> {note}</span>
            ))}
          </div>

          <div className="release-panel">
            <div className="section-heading-left">
              <p className="hero-kicker">Versions</p>
              <h2>Changelog</h2>
            </div>
            {(versions.length ? versions : latest ? [latest] : []).map((release) => (
              <div key={release.id} className="version-row">
                <span>Version {release.version_name} - Code {release.version_code} - {formatDateTime(release.released_at ?? release.release_date)}</span>
                <strong>{release.download_count.toLocaleString()} downloads</strong>
              </div>
            ))}
            {!versions.length && !latest && !loading && (
              <div className="version-row">
                <span>Version 1.0.0</span>
                <strong>Awaiting APK</strong>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
