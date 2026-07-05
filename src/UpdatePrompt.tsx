import { useRegisterSW } from 'virtual:pwa-register/react';
import './UpdatePrompt.css';

// Deliberately not auto-applied: conversions run for minutes in this page's
// JS, and a forced reload mid-conversion would kill it. The user applies
// updates on their own schedule instead.
function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="update-prompt">
      <span>A new version is available.</span>
      <button type="button" onClick={() => updateServiceWorker(true)}>
        Reload to update
      </button>
      <button type="button" className="dismiss" onClick={() => setNeedRefresh(false)}>
        Dismiss
      </button>
    </div>
  );
}

export default UpdatePrompt;
