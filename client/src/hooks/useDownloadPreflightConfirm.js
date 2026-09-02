import { useCallback, useState } from 'react';

// Shared "preview a weight download, then confirm" state machine. Two near-
// identical copies (LocalLlmTab's model/spec-decode/MTPLX downloads, Loras'
// Civitai/HuggingFace installs) collapsed to one hook: request() shows a
// loading modal, resolves the disk-preflight assessment, and holds the
// caller's `run` callback until confirmRun() fires it.
//
// Usage:
//   const { confirm, request, cancel, confirmRun } = useDownloadPreflightConfirm();
//   const install = (modelId) => request({
//     title: 'Install local model',
//     preview: () => previewLocalLlmDownload({ kind: 'install', backend, modelId }, { silent: true }),
//     run: () => startInstall(modelId),
//   });
//   <DownloadPreflightConfirm open={Boolean(confirm)} {...confirm} onCancel={cancel} onConfirm={confirmRun} />
export default function useDownloadPreflightConfirm() {
  const [confirm, setConfirm] = useState(null);

  const request = useCallback(({ title, preview, run }) => {
    setConfirm({ title, loading: true, error: null, assessment: null, run: null });
    return preview()
      .then((assessment) => {
        setConfirm({ title, loading: false, error: null, assessment, run });
      })
      .catch((err) => {
        setConfirm({
          title,
          loading: false,
          error: err?.message || 'Could not check disk space',
          assessment: null,
          run: null,
        });
      });
  }, []);

  const cancel = useCallback(() => setConfirm(null), []);
  const confirmRun = useCallback(() => {
    setConfirm((prev) => {
      prev?.run?.();
      return null;
    });
  }, []);

  return { confirm, request, cancel, confirmRun };
}
