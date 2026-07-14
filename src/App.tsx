import { canEncodeVideo } from 'mediabunny';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './App.css';
import { setAppBusy } from './lib/appBusy';
import { convertVideo, type ConversionPhase, type ConvertResult } from './lib/convert';

const MB = 1024 * 1024;
const SIZE_PRESETS_MB = [10, 25, 50, 100];
const DEFAULT_TARGET_MB = 25;

type Status = 'idle' | 'converting' | 'done' | 'error';

// Errors are stored as translation keys (or a raw engine message) and only
// rendered through t(), so an error that is on screen when the user switches
// language re-renders in the new language.
type AppError = { key: string; params?: Record<string, unknown> } | { message: string };

function formatBytes(bytes: number): string {
  return `${(bytes / MB).toFixed(2)} MB`;
}

function App() {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [targetMb, setTargetMb] = useState(DEFAULT_TARGET_MB);
  const [hevcAvailable, setHevcAvailable] = useState(false);
  // H.265 is used automatically whenever the GPU can hardware-encode it. This
  // opt-in forces the universally-playable H.264 instead, for the cases the app
  // can't detect: some players and upload targets won't inline-preview HEVC.
  const [forceH264, setForceH264] = useState(false);
  const [stripMetadata, setStripMetadata] = useState(true);
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<ConversionPhase>('encoding');
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [receivingShare, setReceivingShare] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const shareTargetPending = useRef(location.search.includes('share-target'));
  // Set when the user cancels the share handoff: the worker may still deliver
  // the file (or an error) afterwards, and both should be dropped silently.
  // Never reset — a new share launch is a fresh navigation.
  const shareCancelled = useRef(false);
  const cancelShareRef = useRef<() => void>(() => {});

  useEffect(() => {
    canEncodeVideo('hevc', { hardwareAcceleration: 'prefer-hardware', width: 1280, height: 720, bitrate: 4_000_000 })
      .then((supported) => setHevcAvailable(supported))
      .catch(() => setHevcAvailable(false));
  }, []);

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  // A loaded file covers every state a reload would destroy: the selection
  // itself, a conversion in flight, and a result not yet downloaded (reset()
  // clears the file along with the rest). A share handoff in flight counts
  // too — the file only exists in the old worker's memory, so an auto-update
  // reload here would drop it on the floor with no error.
  useEffect(() => {
    setAppBusy(file !== null || receivingShare);
  }, [file, receivingShare]);

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
        setError({ key: 'errors.notVideo' });
        return;
      }
      reset();
      setFile(chosen);
    },
    [reset],
  );

  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    // Two separate deadlines: the handshake with the worker should be nearly
    // instant, but streaming the body can legitimately take minutes when the
    // sharing app has to pull the video down from the cloud first.
    let handshakeTimer: number | undefined;
    let transferTimer: number | undefined;
    const clearTimers = () => {
      clearTimeout(handshakeTimer);
      clearTimeout(transferTimer);
    };
    cancelShareRef.current = () => {
      shareCancelled.current = true;
      clearTimers();
      setReceivingShare(false);
    };
    const onMessage = (event: MessageEvent) => {
      if (shareCancelled.current) return;
      if (event.data?.type === 'SHARE_TARGET_RECEIVING') {
        clearTimeout(handshakeTimer);
        transferTimer = window.setTimeout(() => {
          setReceivingShare(false);
          setError({ key: 'errors.shareTimeout' });
        }, 300_000);
      } else if (event.data?.type === 'SHARE_TARGET_FILE' && event.data.file instanceof File) {
        clearTimers();
        setReceivingShare(false);
        // handleFile() calls reset(), so a file that arrives after an error
        // above still loads and clears the error.
        handleFile(event.data.file);
      } else if (event.data?.type === 'SHARE_TARGET_ERROR') {
        clearTimers();
        setReceivingShare(false);
        setError({ key: 'errors.shareFailed', params: { message: event.data.message } });
      }
    };
    sw.addEventListener('message', onMessage);
    sw.startMessages();
    // The service worker holds the shared file until the page confirms it is
    // listening, so tell it once per share-target launch. The ref (rather
    // than checking location.search here) keeps a StrictMode remount from
    // seeing the already-cleaned URL and skipping the listener setup.
    if (shareTargetPending.current) {
      shareTargetPending.current = false;
      history.replaceState(null, '', location.pathname);
      setReceivingShare(true);
      sw.controller?.postMessage('share-ready');
      handshakeTimer = window.setTimeout(() => {
        setReceivingShare(false);
        setError({ key: 'errors.shareNeverArrived' });
      }, 10_000);
    }
    return () => {
      clearTimers();
      sw.removeEventListener('message', onMessage);
    };
  }, [handleFile]);

  const handleConvert = useCallback(async () => {
    if (!file) return;
    setStatus('converting');
    setProgress(0);
    setPhase('encoding');
    setError(null);
    // H.265 whenever the GPU supports it, unless the user forces H.264.
    const preferHevc = hevcAvailable && !forceH264;
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
      setError(e instanceof Error ? { message: e.message } : { key: 'errors.conversionFailed' });
      setStatus('error');
    }
  }, [file, targetMb, hevcAvailable, forceH264, stripMetadata]);

  const downloadName = file ? `${file.name.replace(/\.[^.]+$/, '')}-shrunk.mp4` : 'shrunk.mp4';
  const codecLabel = result?.codec === 'hevc' ? 'H.265' : 'H.264';

  return (
    <div className="app">
      <header>
        <h1>Video Shrinker</h1>
        <p className="tagline">{t('tagline')}</p>
        <ul className="privacy-facts">
          <li>{t('privacy.local')}</li>
          <li>{t('privacy.clean')}</li>
          <li>{t('privacy.installable')}</li>
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
              <strong>{t('dropzone.prompt')}</strong>
              <span>{t('dropzone.formats')}</span>
            </div>
          )}
        </div>

        <div className="controls">
          <label className="field">
            <span>{t('controls.targetSize')}</span>
            <div className="size-input-row">
              <div className="size-input">
                <input
                  type="number"
                  min={1}
                  value={targetMb}
                  onChange={(e) => setTargetMb(Math.max(1, Number(e.target.value) || 1))}
                />
                <span className="unit">MB</span>
              </div>
              <div className="stepper">
                <button
                  type="button"
                  className="step-button"
                  aria-label={t('controls.decrease')}
                  onClick={() => setTargetMb((mb) => Math.max(1, mb - 1))}
                >
                  −
                </button>
                <button
                  type="button"
                  className="step-button"
                  aria-label={t('controls.increase')}
                  onClick={() => setTargetMb((mb) => mb + 1)}
                >
                  +
                </button>
              </div>
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
              <input type="checkbox" checked={forceH264} onChange={(e) => setForceH264(e.target.checked)} />
              <span>{t('controls.forceH264')}</span>
            </label>
          )}

          <label className="checkbox">
            <input type="checkbox" checked={stripMetadata} onChange={(e) => setStripMetadata(e.target.checked)} />
            <span>{t('controls.stripMetadata')}</span>
          </label>
        </div>

        <button type="button" className="convert-button" disabled={!file || status === 'converting'} onClick={handleConvert}>
          {status === 'converting' ? (phase === 'refining' ? t('convert.refining') : t('convert.converting')) : t('convert.start')}
        </button>

        {status === 'converting' && (
          <div className="progress-wrap">
            {phase === 'refining' && (
              <p className="phase-note">{t('convert.refineNote')}</p>
            )}
            <div className="progress">
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span className="progress-label">{Math.round(progress * 100)}%</span>
            </div>
          </div>
        )}

        {error && <div className="message error">{'key' in error ? t(error.key, error.params) : error.message}</div>}

        {status === 'done' && result && resultUrl && (
          <div className="result">
            <p>
              {t('result.done')} <strong>{codecLabel} · {formatBytes(result.blob.size)}</strong>
              <br />
              <span className="result-detail">
                {result.engine === 'webcodecs'
                  ? result.hardwareAccelerated
                    ? t('result.webcodecs')
                    : t('result.webcodecsSoftware')
                  : t('result.ffmpeg')}
              </span>
            </p>
            <a className="download-button" href={resultUrl} download={downloadName}>
              {t('result.download')}
            </a>
            <button type="button" className="link-button" onClick={reset}>
              {t('result.convertAnother')}
            </button>
          </div>
        )}
      </main>

      {receivingShare && (
        <div className="share-scrim" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
          <div className="share-dialog">
            <h2 id="share-dialog-title">{t('share.preparing')}</h2>
            <div className="share-dialog-status">
              <svg className="share-spinner" viewBox="0 0 48 48" aria-hidden="true">
                <circle cx="24" cy="24" r="20" fill="none" strokeWidth="4" />
              </svg>
              <span>{t('share.progress', { done: 0, total: 1 })}</span>
            </div>
            <div className="share-dialog-actions">
              <button type="button" className="share-dialog-cancel" onClick={() => cancelShareRef.current()}>
                {t('share.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer>
        <p className="footer-note">{t('footer.note')}</p>
        <div className="footer-bottom">
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
        </div>
      </footer>
    </div>
  );
}

export default App;
