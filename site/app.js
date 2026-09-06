'use strict';

// Judge 文件閱讀器
//
// 內容來源是專案根目錄的 Judge.md，於頁面載入時即時讀取並在瀏覽器端解析。
// 刻意不做預先編譯：任何編譯步驟都會產生第二份可能過期的內容，而使用者
// 只要忘記重跑一次，網頁就會顯示舊資料。改用即時讀取後，「重新整理」是
// 唯一的更新動作，不存在會被遺忘的步驟。

(function () {
  // Judge.md 位於 site/ 的上一層，也就是伺服器的文件根目錄
  const SOURCE_URL = '../Judge.md';

  const docEl = document.getElementById('doc');
  const tocEl = document.getElementById('toc');
  const searchInput = document.getElementById('search-input');
  const searchStatus = document.getElementById('search-status');
  const tocEmptyEl = document.getElementById('toc-empty');

  const SEARCH_DEBOUNCE_MS = 150;

  /** 目前查詢的所有命中處，依文件順序排列 */
  let searchHits = [];
  /** 目前所在命中處的索引；沒有命中時為 -1 */
  let currentHit = -1;

  /**
   * 文件的章節模型，於渲染後建立一次。
   * 每一項：{ id, level, text, heading, link, item, parent }
   * parent 指向上層章節的索引（沒有上層時為 -1），搜尋過濾要靠它保留階層。
   */
  let sections = [];

  /**
   * 建立 Markdown 解析器。
   *
   * marked 5 之後移除了 sanitize 選項，因此改以覆寫 renderer.html 來轉義
   * 來源中的原始 HTML。這個覆寫同時涵蓋區塊級與行內兩種 HTML token。
   * Judge.md 由使用者自己撰寫、風險極低，但關閉內嵌 HTML 可避免日後從
   * 外部貼上內容時產生非預期的渲染結果。
   */
  function createParser() {
    const parser = new marked.Marked();
    parser.use({
      renderer: {
        html(token) {
          return escapeHtml(token.raw != null ? token.raw : token.text);
        },
      },
    });
    return parser;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 讓指向外部主機的連結在新分頁開啟。
   *
   * rel 同時帶上 noopener 與 noreferrer：noopener 阻斷新分頁透過
   * window.opener 取得本頁的 scripting 參照，noreferrer 一併避免送出來源位址。
   */
  function markExternalLinks(container) {
    const links = container.querySelectorAll('a[href]');
    for (const link of links) {
      let url;
      try {
        url = new URL(link.getAttribute('href'), window.location.href);
      } catch {
        continue; // href 無法解析成合法網址，維持原樣
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (url.origin === window.location.origin) continue;

      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }

  /**
   * 顯示讀取失敗的說明。
   *
   * 這段文案本身就是交付內容的一部分。最常見的失敗是使用者直接雙擊
   * index.html——瀏覽器的 CORS 政策會擋掉 file:// 底下的 fetch，而原始的
   * fetch 錯誤訊息（"Failed to fetch"）完全無法讓人知道該怎麼辦。因此這裡
   * 分辨失敗原因並直接寫出對應的處理方式，且絕不留下空白畫面。
   *
   * @param {string} title 一句話說明發生什麼事
   * @param {string[]} steps 使用者接下來該做的事
   * @param {string} [technical] 原始技術訊息，附在最後供進一步排查
   */
  function showLoadFailure(title, steps, technical) {
    docEl.textContent = '';

    const box = document.createElement('div');
    box.className = 'load-error';

    const heading = document.createElement('h2');
    heading.textContent = title;
    box.append(heading);

    const list = document.createElement('ol');
    for (const step of steps) {
      const item = document.createElement('li');
      item.textContent = step;
      list.append(item);
    }
    box.append(list);

    if (technical) {
      const detail = document.createElement('p');
      detail.className = 'load-error-technical';
      detail.textContent = `技術細節：${technical}`;
      box.append(detail);
    }

    docEl.append(box);
  }

  /**
   * 這個頁面是本機開的，還是線上開的？
   *
   * 兩者的失敗處理方式完全不同，而給錯指示比不給指示更糟：叫線上訪客去
   * 「雙擊 start.cmd」會讓他們去找一個自己根本沒有的檔案，還以為是自己
   * 操作錯誤。
   */
  function isLocalHost() {
    return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  }

  function showFileProtocolFailure() {
    showLoadFailure('這個頁面必須透過 start.cmd 啟動', [
      '關閉這個分頁。',
      '回到 site 資料夾，雙擊 start.cmd。',
      '瀏覽器會自動開啟正確的位址，文件就會顯示出來。',
    ], '瀏覽器的 CORS 政策會阻擋 file:// 協定下的檔案讀取，' +
       '因此直接開啟 index.html 無法取得 Judge.md。');
  }

  function showNotFoundFailure() {
    if (isLocalHost()) {
      showLoadFailure('找不到 Judge.md', [
        '確認 Judge.md 仍位於專案根目錄，也就是 site 資料夾的上一層。',
        '若檔案被改名或移動，請放回原位或改回原檔名。',
        '完成後重新整理這個頁面。',
      ], `伺服器在 ${SOURCE_URL} 找不到檔案（HTTP 404）。`);
      return;
    }

    showLoadFailure('目前無法取得教材內容', [
      '這份文件可能尚未發布，或網站正在更新中。',
      '請稍後重新整理這個頁面。',
      '若持續無法顯示，請聯絡管理這個網站的人。',
    ], `伺服器在 ${SOURCE_URL} 找不到檔案（HTTP 404）。`);
  }

  function showUnreachableFailure(detail) {
    if (isLocalHost()) {
      showLoadFailure('無法讀取 Judge.md', [
        '確認啟動 start.cmd 的主控台視窗仍然開著。',
        '若視窗已關閉，請重新雙擊 start.cmd。',
        '完成後重新整理這個頁面。',
      ], detail);
      return;
    }

    showLoadFailure('目前無法取得教材內容', [
      '網路連線可能中斷，或網站正在更新中。',
      '請稍後重新整理這個頁面。',
    ], detail);
  }

  /**
   * 由標題文字產生錨點 id：去除前後空白，內部空白換為連字號。
   *
   * 刻意不用流水編號（sec-1-2 之類）。使用者日後在文件中間插入章節時，
   * 編號式錨點會讓所有後續書籤指向錯誤的位置；文字式錨點則只有被改名的
   * 那一節會失效，影響範圍小且可預期。
   *
   * 文件是中文，id 會包含中文字元。HTML5 允許這樣用，產生連結時做 URI
   * 編碼即可。
   */
  function slugify(text) {
    return text.trim().replace(/\s+/g, '-');
  }

  /**
   * 掃描已渲染的內文，替 H1/H2/H3 建立唯一錨點並產生側邊目錄。
   * 目錄用扁平清單加層級 class 呈現縮排——搜尋要能單獨隱藏／顯示個別項目
   * 並保留其上層項目，扁平結構處理這件事比巢狀 ul 直接得多。
   */
  function buildToc() {
    const headings = docEl.querySelectorAll('h1, h2, h3');
    const usedIds = new Map();
    const list = document.createElement('ul');
    list.className = 'toc-list';

    sections = [];

    for (const heading of headings) {
      const text = heading.textContent.trim();
      const level = Number(heading.tagName.slice(1));

      // 重複的標題文字附加 -2、-3… 後綴以維持 id 唯一
      const base = slugify(text);
      const seen = usedIds.get(base) || 0;
      const id = seen === 0 ? base : `${base}-${seen + 1}`;
      usedIds.set(base, seen + 1);
      heading.id = id;

      const item = document.createElement('li');
      item.className = `toc-item toc-level-${level}`;

      const link = document.createElement('a');
      link.className = 'toc-link';
      link.href = `#${encodeURIComponent(id)}`;
      link.textContent = text;
      item.append(link);
      list.append(item);

      // 上層是前一個層級較小的章節
      let parent = -1;
      for (let i = sections.length - 1; i >= 0; i -= 1) {
        if (sections[i].level < level) { parent = i; break; }
      }

      sections.push({ id, level, text, heading, link, item, parent });
    }

    tocEl.textContent = '';
    tocEl.append(list);
  }

  function scrollToSection(section) {
    section.heading.scrollIntoView({ block: 'start' });
    // 讓網址列反映當前位置，使用者才能把小節加入書籤；
    // 用 replaceState 而非直接設定 hash，避免每次點選都留下一筆歷史紀錄
    window.history.replaceState(null, '', `#${encodeURIComponent(section.id)}`);
  }

  function wireTocNavigation() {
    tocEl.addEventListener('click', (event) => {
      const link = event.target.closest('.toc-link');
      if (!link) return;
      const index = [...tocEl.querySelectorAll('.toc-link')].indexOf(link);
      if (index < 0) return;
      event.preventDefault();
      scrollToSection(sections[index]);
    });
  }

  /**
   * 捲動位置追蹤：任一時刻恰有一個目錄項目被標示為當前位置。
   *
   * 用 IntersectionObserver 而非 scroll 事件監聽：scroll 監聽需要自行節流，
   * 而且每次都要重算所有標題的位置；IntersectionObserver 由瀏覽器排程，
   * 效能與程式碼複雜度都較低。
   *
   * 判定規則是「最後一個頂緣已越過視窗上方判定線的標題」。實作方式是把
   * 觀測區以 rootMargin 壓成貼齊頂部的一條窄帶：任何標題只要離開這條帶子
   * 的上方，就代表已經捲過判定線。每次交錯事件後重新掃描一次所有標題的
   * 位置來決定 active，而不是只看這次進出的那一個——後者在快速捲動、
   * 一次跨過多個標題時會判錯。
   */
  function setUpScrollSpy() {
    if (sections.length === 0) return;

    const setActive = (index) => {
      for (let i = 0; i < sections.length; i += 1) {
        sections[i].item.classList.toggle('is-active', i === index);
      }
    };

    const recomputeActive = () => {
      // 判定線設在視窗頂端下方一小段，避免標題剛貼齊頂端時反覆切換
      const line = 80;
      let active = 0;
      for (let i = 0; i < sections.length; i += 1) {
        if (sections[i].heading.getBoundingClientRect().top <= line) {
          active = i;
        } else {
          break;
        }
      }
      setActive(active);
    };

    const observer = new IntersectionObserver(recomputeActive, {
      rootMargin: '0px 0px -90% 0px',
      threshold: [0, 1],
    });
    for (const section of sections) observer.observe(section.heading);

    // 文件位於初始捲動位置時，第一個標題即為當前位置
    recomputeActive();
  }

  /**
   * 記錄每個章節「自身」的內文元素：從該標題起，到下一個標題為止，
   * 不含任何子章節的內容。
   *
   * 這個界線很重要。若把子章節也算進上層章節的本文，搜尋「加時」時 H1
   * 「巡場」會因為底下的 Judge Call 流程含有該詞而被判為命中——但它真正
   * 該扮演的角色是保留階層用的脈絡項目。範圍只到下一個標題為止，命中與
   * 脈絡的區分才會正確。
   */
  function indexSectionBodies() {
    const children = [...docEl.children];
    const headingIndex = new Map();
    children.forEach((el, i) => headingIndex.set(el, i));

    for (let s = 0; s < sections.length; s += 1) {
      const start = headingIndex.get(sections[s].heading);
      const next = sections[s + 1];
      const end = next ? headingIndex.get(next.heading) : children.length;
      // 不含標題本身，只含其下、下一個標題之前的內文元素
      sections[s].bodyElements = children.slice(start + 1, end);
    }
  }

  /**
   * 比對規則：不分大小寫的子字串比對。
   *
   * 中文沒有詞界，因此不做分詞，直接以子字串處理。也不設最短查詢長度——
   * 「桌」這類單字查詢在這份文件裡是合理需求，強制兩字以上會誤傷。單字
   * 查詢造成的大量命中由使用者自行補字收斂，效能則以防抖控制。
   */
  function matchesQuery(text, query) {
    return text.toLowerCase().includes(query.toLowerCase());
  }

  function sectionMatches(section, query) {
    if (matchesQuery(section.text, query)) return true;
    return section.bodyElements.some((el) => matchesQuery(el.textContent, query));
  }

  function debounce(fn, waitMs) {
    let timer = null;
    return function debounced(...args) {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, waitMs);
    };
  }

  function countOccurrences(text, query) {
    if (query === '') return 0;
    const haystack = text.toLowerCase();
    const needle = query.toLowerCase();
    let count = 0;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      count += 1;
      from = at + needle.length;
    }
    return count;
  }

  /**
   * 在內文中標出所有命中處。
   *
   * 必須走訪文字節點後再包覆 <mark>，不能對序列化的 HTML 字串做取代——
   * 字串取代會命中標籤名稱與屬性值（例如 href 裡的文字），破壞標記結構。
   *
   * 這裡只加上標記，不隱藏也不摺疊任何未命中的內容。搜尋「加時」時，
   * Judge Call 流程第 8 步若只剩孤立的「給予對應的加時」而看不到前一句
   * 「應告知玩家當下情況」，這個結果對裁判是沒有用的——上下文本身就是
   * 內容的一部分。定位交給目錄，閱讀留給內文。
   *
   * @returns {HTMLElement[]} 依文件順序排列的所有命中處
   */
  function highlightMatches(query) {
    const needle = query.toLowerCase();
    if (needle === '') return [];

    // 先收集再修改：邊走訪邊改 DOM 會讓 TreeWalker 的位置失效
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const hits = [];
    for (const node of textNodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      if (!lower.includes(needle)) continue;

      const fragment = document.createDocumentFragment();
      let from = 0;
      for (;;) {
        const at = lower.indexOf(needle, from);
        if (at === -1) break;
        if (at > from) fragment.append(text.slice(from, at));
        const mark = document.createElement('mark');
        mark.className = 'search-hit';
        mark.textContent = text.slice(at, at + needle.length);
        fragment.append(mark);
        hits.push(mark);
        from = at + needle.length;
      }
      if (from < text.length) fragment.append(text.slice(from));
      node.parentNode.replaceChild(fragment, node);
    }
    return hits;
  }

  /**
   * 移除所有高亮，把內文還原成渲染當下的樣子。
   *
   * 刻意不用「重設 innerHTML」還原：那會建立全新的元素，讓 sections 持有的
   * 標題參照與 IntersectionObserver 的註冊全部失效，搜尋過一次之後目錄跳轉
   * 與捲動追蹤就再也不會動。改為把每個 <mark> 換回文字節點，再對其父元素
   * normalize() 合併被切開的相鄰文字節點——元素identity 全程不變。
   */
  function clearHighlights() {
    const marks = docEl.querySelectorAll('mark.search-hit');
    const parents = new Set();
    for (const mark of marks) {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parents.add(parent);
    }
    for (const parent of parents) parent.normalize();
  }

  /**
   * 依查詢詞過濾側邊目錄。
   *
   * 只留下自身命中的小節，外加它們的上層項目——沒有上層項目的話，過濾後
   * 的目錄會變成一串失去階層脈絡的扁平標題，讀者無從判斷某個小節屬於哪個
   * 章節。純粹作為脈絡保留的項目標上 is-context，樣式上與真正命中的項目
   * 區分開來。
   */
  function filterToc(query) {
    const matched = new Set();
    for (let i = 0; i < sections.length; i += 1) {
      if (sectionMatches(sections[i], query)) matched.add(i);
    }

    const visible = new Set(matched);
    for (const index of matched) {
      let parent = sections[index].parent;
      while (parent !== -1) {
        visible.add(parent);
        parent = sections[parent].parent;
      }
    }

    for (let i = 0; i < sections.length; i += 1) {
      const { item } = sections[i];
      item.classList.toggle('is-filtered-out', !visible.has(i));
      item.classList.toggle('is-context', visible.has(i) && !matched.has(i));
      item.classList.toggle('is-match', matched.has(i));
    }

    return matched.size;
  }

  function resetTocFilter() {
    for (const section of sections) {
      section.item.classList.remove('is-filtered-out', 'is-context', 'is-match');
    }
  }

  function updateCounter() {
    const total = searchHits.length;
    const ordinal = total === 0 ? 0 : currentHit + 1;
    searchStatus.textContent = `${ordinal} / ${total}`;
  }

  /**
   * 將指定命中處設為當前位置：樣式與其他命中處區分，並捲入視野。
   * 索引以取模方式換算，因此在頭尾兩端都會循環。
   */
  function goToHit(index) {
    if (searchHits.length === 0) return;

    if (currentHit >= 0 && searchHits[currentHit]) {
      searchHits[currentHit].classList.remove('is-current');
    }

    const total = searchHits.length;
    currentHit = ((index % total) + total) % total;

    const hit = searchHits[currentHit];
    hit.classList.add('is-current');
    hit.scrollIntoView({ block: 'center' });
    updateCounter();
  }

  function applySearch(rawQuery) {
    const query = rawQuery.trim();
    clearHighlights();
    searchHits = [];
    currentHit = -1;

    if (query === '') {
      resetTocFilter();
      tocEmptyEl.hidden = true;
      searchStatus.textContent = '';
      return;
    }

    searchHits = highlightMatches(query);
    filterToc(query);

    if (searchHits.length === 0) {
      // 目錄區顯示無結果訊息；內文保持完整、不加任何標記
      tocEmptyEl.hidden = false;
      updateCounter();
      return;
    }

    tocEmptyEl.hidden = true;
    currentHit = 0;
    searchHits[0].classList.add('is-current');
    updateCounter();
  }

  function wireSearch() {
    const runSearch = debounce(() => applySearch(searchInput.value), SEARCH_DEBOUNCE_MS);
    searchInput.addEventListener('input', runSearch);

    searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (searchHits.length === 0) return;
      goToHit(currentHit + (event.shiftKey ? -1 : 1));
    });
  }

  /**
   * 窄螢幕的側欄開闔。
   *
   * 桌機寬度下側欄常駐、漢堡按鈕由 CSS 隱藏，所以這裡的狀態在寬螢幕上
   * 不會被用到。點選目錄項目後主動關閉側欄：在手機上側欄是蓋在內文之上的，
   * 不關掉的話使用者跳到目標小節卻看不見它。
   */
  function wireSidebar() {
    const toggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebar-scrim');

    const setOpen = (open) => {
      document.body.classList.toggle('sidebar-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '關閉目錄' : '開啟目錄');
      scrim.hidden = !open;
    };

    toggle.addEventListener('click', () => {
      setOpen(!document.body.classList.contains('sidebar-open'));
    });

    scrim.addEventListener('click', () => setOpen(false));

    tocEl.addEventListener('click', (event) => {
      if (event.target.closest('.toc-link')) setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });

    setOpen(false);
  }

  /** 支援直接以帶 hash 的網址開啟某個小節 */
  function scrollToInitialHash() {
    if (!window.location.hash) return;
    const wanted = decodeURIComponent(window.location.hash.slice(1));
    const target = sections.find((s) => s.id === wanted);
    if (target) target.heading.scrollIntoView({ block: 'start' });
  }

  async function render() {
    // file:// 底下 fetch 必定失敗，直接給出可執行的指示，
    // 不讓使用者看到無從下手的 "Failed to fetch"
    if (window.location.protocol === 'file:') {
      showFileProtocolFailure();
      return;
    }

    let response;
    try {
      // no-store 處理瀏覽器層的快取。本機伺服器本來就回應 no-store，
      // 這行是為了線上情境——託管平台的 CDN 快取不在瀏覽器能控制的範圍，
      // 那一層的延遲屬平台限制，不在此嘗試以輪詢或時間戳參數繞過。
      response = await fetch(SOURCE_URL, { cache: 'no-store' });
    } catch (err) {
      showUnreachableFailure(err.message);
      return;
    }

    if (response.status === 404) {
      showNotFoundFailure();
      return;
    }

    if (!response.ok) {
      showUnreachableFailure(`伺服器回應 HTTP ${response.status}。`);
      return;
    }

    const markdown = await response.text();
    docEl.innerHTML = createParser().parse(markdown);
    markExternalLinks(docEl);
    buildToc();
    indexSectionBodies();
    wireTocNavigation();
    wireSearch();
    wireSidebar();
    setUpScrollSpy();
    scrollToInitialHash();
  }

  render();
})();
