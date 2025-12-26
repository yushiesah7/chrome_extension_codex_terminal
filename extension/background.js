// 拡張インストール時に、サイドパネルをツールバーのアクションボタンで開けるように設定する。
chrome.runtime.onInstalled.addListener(async () => {
  // ページ側の許可は要らないが、ユーザー操作（アクションボタン）を前提にする。
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// アクションボタン押下で、該当タブのサイドパネルを開く。
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});
