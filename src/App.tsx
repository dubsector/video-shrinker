import { canEncodeVideo } from 'mediabunny';
import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { convertVideo, type ConversionPhase, type ConvertResult } from './lib/convert';

const MB = 1024 * 1024;
const SIZE_PRESETS_MB = [10, 25, 50, 100];
const DEFAULT_TARGET_MB = 25;

type Status = 'idle' | 'converting' | 'done' | 'error';

function formatBytes(bytes: number): string {
  return `${(bytes / MB).toFixed(2)} MB`;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [targetMb, setTargetMb] = useState(DEFAULT_TARGET_MB);
  const [hevcAvailable, setHevcAvailable] = useState(false);
  const [preferHevc, setPreferHevc] = useState(false);
  const [stripMetadata, setStripMetadata] = useState(true);
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<ConversionPhase>('encoding');
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    canEncodeVideo('hevc', { hardwareAcceleration: 'prefer-hardware', width: 1280, height: 720, bitrate: 4_000_000 })
      .then((supported) => {
        setHevcAvailable(supported);
        // Default to H.265 when this GPU can hardware-encode it: modern
        // players (including Discord's) handle it fine, and it produces a
        // meaningfully smaller file at the same quality. Still user-toggleable.
        if (supported) setPreferHevc(true);
      })
      .catch(() => setHevcAvailable(false));
  }, []);

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  const reset = useCallback(() => {
    setFile(null);
    setStatus('idle');
    setProgress(0);
    setPhase('encoding');
    setResult(null);
    setError(null);
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const handleFile = useCallback(
    (chosen: File | null) => {
      if (!chosen) return;
      if (!chosen.type.startsWith('video/')) {
        setError('Please choose a video file.');
        return;
      }
      reset();
      setFile(chosen);
    },
    [reset],
  );

  const handleConvert = useCallback(async () => {
    if (!file) return;
    setStatus('converting');
    setProgress(0);
    setPhase('encoding');
    setError(null);
    try {
      const converted = await convertVideo(file, targetMb * MB, {
        preferHevc,
        stripMetadata,
        onProgress: (p, currentPhase) => {
          setProgress(p);
          setPhase(currentPhase);
        },
      });
      setResult(converted);
      setResultUrl(URL.createObjectURL(converted.blob));
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Conversion failed.');
      setStatus('error');
    }
  }, [file, targetMb, preferHevc, stripMetadata]);

  const downloadName = file ? `${file.name.replace(/\.[^.]+$/, '')}-shrunk.mp4` : 'shrunk.mp4';

  return (
    <div className="app">
      <header>
        <h1>Video Shrinker</h1>
        <p className="tagline">Shrinks video to whatever size you need, right in the browser.</p>
        <ul className="privacy-facts">
          <li>Your file never leaves this device</li>
          <li>No accounts, no analytics, no cookies</li>
          <li>Installable as an app, works offline after the first load</li>
        </ul>
      </header>

      <main>
        <div
          className={`dropzone${isDragging ? ' dragging' : ''}${file ? ' has-file' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            handleFile(e.dataTransfer.files[0] ?? null);
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="file-info">
              <strong>{file.name}</strong>
              <span>{formatBytes(file.size)}</span>
            </div>
          ) : (
            <div className="file-info">
              <strong>Drop a video here, or click to choose one</strong>
              <span>MP4, MOV, WebM, MKV, and more</span>
            </div>
          )}
        </div>

        <div className="controls">
          <label className="field">
            <span>Target size</span>
            <div className="size-input">
              <input
                type="number"
                min={1}
                value={targetMb}
                onChange={(e) => setTargetMb(Math.max(1, Number(e.target.value) || 1))}
              />
              <span className="unit">MB</span>
            </div>
          </label>

          <div className="presets">
            {SIZE_PRESETS_MB.map((mb) => (
              <button
                key={mb}
                type="button"
                className={targetMb === mb ? 'preset active' : 'preset'}
                onClick={() => setTargetMb(mb)}
              >
                {mb} MB
              </button>
            ))}
          </div>

          {hevcAvailable && (
            <label className="checkbox">
              <input type="checkbox" checked={preferHevc} onChange={(e) => setPreferHevc(e.target.checked)} />
              <span>Try H.265 (smaller file — your GPU supports hardware encoding)</span>
            </label>
          )}

          <label className="checkbox">
            <input type="checkbox" checked={stripMetadata} onChange={(e) => setStripMetadata(e.target.checked)} />
            <span>Strip metadata (recommended)</span>
          </label>
        </div>

        <button type="button" className="convert-button" disabled={!file || status === 'converting'} onClick={handleConvert}>
          {status === 'converting' ? (phase === 'refining' ? 'Refining size…' : 'Converting…') : 'Convert'}
        </button>

        {status === 'converting' && (
          <div className="progress-wrap">
            {phase === 'refining' && (
              <p className="phase-note">First pass overshot the target — re-encoding once more for accuracy.</p>
            )}
            <div className="progress">
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span className="progress-label">{Math.round(progress * 100)}%</span>
            </div>
          </div>
        )}

        {status === 'error' && error && <div className="message error">{error}</div>}

        {status === 'done' && result && resultUrl && (
          <div className="result">
            <p>
              Done — {formatBytes(result.blob.size)} using{' '}
              <strong>
                {result.engine === 'webcodecs'
                  ? `WebCodecs (${result.codec.toUpperCase()}, hardware-accelerated)`
                  : 'ffmpeg.wasm (CPU fallback)'}
              </strong>
            </p>
            <a className="download-button" href={resultUrl} download={downloadName}>
              Download
            </a>
            <button type="button" className="link-button" onClick={reset}>
              Convert another
            </button>
          </div>
        )}
      </main>

      <footer>
        <p>Encoding runs via WebCodecs, with an ffmpeg.wasm fallback for older browsers.</p>
        <p className="footer-links">
          <a href="https://github.com/dubsector/video-shrinker" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <span aria-hidden="true"> · </span>
          <a href="https://dubsector.dev" target="_blank" rel="noopener noreferrer">
            dubsector.dev
          </a>
        </p>
        <p className="build-info" title={__BUILD_INFO__.date}>
          Build {__BUILD_INFO__.date.slice(0, 16).replace('T', ' ')} UTC · {__BUILD_INFO__.commit}
        </p>
      </footer>
    </div>
  );
}

export default App;
