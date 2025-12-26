chrome.runtime.onInstalled.addListener(async () => {
  // Ensure the side panel is enabled on all tabs.
  // (User still needs to open it from the UI or via the action button.)
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});
