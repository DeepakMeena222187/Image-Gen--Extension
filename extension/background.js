// Service worker: opens the side panel, tells content scripts their tab id, saves images.
const openPanel = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(openPanel);
chrome.runtime.onStartup.addListener(openPanel);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'whoami') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return;
  }
  if (msg?.type === 'download') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, conflictAction: 'uniquify', saveAs: false },
      id => sendResponse({ ok: !!id, id, error: chrome.runtime.lastError?.message }),
    );
    return true;
  }
});
