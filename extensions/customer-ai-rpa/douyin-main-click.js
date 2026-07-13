/**
 * @file extensions/customer-ai-rpa/douyin-main-click.js
 * @module RPA 与 Chrome 插件
 * @description 在页面 MAIN world 执行抖音左侧会话点击，绕过部分 React 对隔离世界事件的忽略。
 * @see 联动关注：background.js executeScript world MAIN。
 */
(function registerDouyinMainClick() {
  if (globalThis.__customerAiDouyinMainClick)
    return;
  globalThis.__customerAiDouyinMainClick = true;

  function normalizeName(value) {
    return String(value || '')
      .replace(/\s+/g, '')
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '');
  }

  function parseBadgeCount(text) {
    const count = Number.parseInt(String(text || '').trim(), 10);
    if (!Number.isFinite(count) || count <= 0 || count > 99)
      return 0;
    return count;
  }

  function unreadCountInCard(card) {
    const badgeText = card.querySelector('.life-im-pc-badge-text')?.textContent?.trim() || '';
    const count = parseBadgeCount(badgeText);
    if (count > 0)
      return count;
    const badge = card.querySelector('[class*="badge-number-"], .life-im-pc-badge-sup-show, .life-im-pc-badge-type-danger');
    if (badge) {
      const rect = badge.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        return parseBadgeCount(badge.textContent) || 1;
    }
    for (const node of card.querySelectorAll('sup, .life-im-pc-badge-text, [class*="badge-number-"]')) {
      const parsed = parseBadgeCount(node.textContent);
      if (!parsed)
        continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.width > 36 || rect.height > 36)
        continue;
      return parsed;
    }
    return /用户催促/.test(card.textContent || '') ? 1 : 0;
  }

  function isSystemCard(card) {
    const name = card.querySelector('[class*="uname-"]')?.textContent?.trim() || '';
    return /预警通知|系统消息|系统通知|平台通知|官方通知|消息中心|通知中心/.test(name)
      || /通知$/.test(name);
  }

  globalThis.__customerAiClickDouyinCard = function clickDouyinCard(nameHint) {
    const historyTab = [...document.querySelectorAll('[role="tab"], button, div, span, a')]
      .find((element) => element.textContent?.trim() === '历史咨询');
    const currentTab = [...document.querySelectorAll('[role="tab"], button, div, span, a')]
      .find((element) => element.textContent?.trim() === '当前咨询');
    const historySelected = historyTab && (
      historyTab.getAttribute('aria-selected') === 'true'
      || /active|selected|current/i.test(String(historyTab.className || ''))
      || /active|selected|current/i.test(String(historyTab.parentElement?.className || ''))
    );
    if (historySelected)
      return { ok: false, reason: 'history_tab' };
    if (currentTab && !historySelected) {
      // 确保自动切换只在“当前咨询”列表里找未读。
    }
    const cards = [...document.querySelectorAll('#list-container [class*="contactCard-"]')];
    const unreadCards = cards.filter((card) => unreadCountInCard(card) > 0 && !isSystemCard(card));
    const customerUnreadCards = unreadCards.length
      ? unreadCards
      : cards.filter((card) => unreadCountInCard(card) > 0);
    if (!cards.length)
      return { ok: false, reason: 'no_cards' };
    let target = customerUnreadCards[0] || unreadCards[0] || cards[0];
    if (nameHint) {
      const wanted = normalizeName(nameHint);
      const pool = customerUnreadCards.length ? customerUnreadCards : (unreadCards.length ? unreadCards : cards);
      const matched = pool.find((card) => {
        const name = normalizeName(card.querySelector('[class*="uname-"]')?.textContent || '');
        return name && (name.includes(wanted) || wanted.includes(name));
      }) || cards.find((card) => {
        const name = normalizeName(card.querySelector('[class*="uname-"]')?.textContent || '');
        return name && (name.includes(wanted) || wanted.includes(name));
      });
      if (matched)
        target = matched;
    }
    if (!customerUnreadCards.length && !unreadCards.length && !nameHint)
      return { ok: false, reason: 'no_unread_card', cards: cards.length };
    const clickTarget = target.querySelector('[class*="uname-"]')
      || target.querySelector('[class*="message-"]')
      || target;
    clickTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    clickTarget.click();
    target.click();
    return {
      ok: true,
      name: target.querySelector('[class*="uname-"]')?.textContent?.trim() || '',
      unreadCards: unreadCards.length
    };
  };
})();
