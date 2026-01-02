// 拡張インストール時に、サイドパネルをツールバーのアクションボタンで開けるように設定する。
chrome.runtime.onInstalled.addListener(async () => {
  // ページ側の許可は要らないが、ユーザー操作（アクションボタン）を前提にする。
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // 右クリック（選択範囲）から「Codexに聞く」を出す
  // update時にも重複しないように、一度全部消してから作り直す
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'askCodex',
      title: 'Codexに聞く（選択範囲）',
      contexts: ['selection']
    });
  });
});

// アクションボタン押下で、該当タブのサイドパネルを開く。
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});

// 選択範囲をCodexへ投げる（サイドパネルを開き、sidepanel側で処理させる）
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'askCodex') return;
  if (!tab?.id) return;

  const selectionText = typeof info.selectionText === 'string' ? info.selectionText : '';
  const pageUrl = typeof info.pageUrl === 'string' ? info.pageUrl : '';

  // NOTE: `chrome.sidePanel.open()` は user gesture が必要。
  // 先に await すると gesture が失われるため、open は同期的に呼ぶ。
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});

  // sidepanel が開く前でも拾えるように session storage に積む
  chrome.storage.session
    .set({
      pendingCodexAsk: {
        selectionText,
        pageUrl,
        question: '',
        autoAsk: false,
        createdAt: Date.now()
      }
    })
    .then(() => {
      // sidepanel が既に開いている場合の即時更新用（未オープンでも問題なし）
      chrome.runtime.sendMessage({ type: 'pendingCodexAskUpdated' }).catch(() => {});
    })
    .catch(() => {
      chrome.runtime.sendMessage({ type: 'pendingCodexAskUpdated' }).catch(() => {});
    });
});
