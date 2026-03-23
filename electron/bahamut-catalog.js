const ANI_ROOT = 'https://ani.gamer.com.tw';

function createHeaders(referer = `${ANI_ROOT}/`) {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    Referer: referer,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function cleanHtmlText(text) {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeUrl(url) {
  if (!url) {
    return '';
  }

  return url.startsWith('http') ? url : new URL(url, ANI_ROOT).toString();
}

function uniqueBy(items, keySelector) {
  const seen = new Set();

  return items.filter((item) => {
    const key = keySelector(item);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function extractMatch(text, pattern) {
  const match = pattern.exec(text);
  return match?.[1] ? cleanHtmlText(match[1]) : '';
}

async function fetchHtml(url, options = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    ...options,
  });

  if (!response.ok) {
    throw new Error(`Bahamut page returned ${response.status}`);
  }

  return response.text();
}

function parseSearchResults(html) {
  const resultTitleIndex = html.indexOf('<h1 class="theme-title">搜尋結果</h1>');

  if (resultTitleIndex < 0) {
    return [];
  }

  let sectionHtml = html.slice(resultTitleIndex);
  const wishIndex = sectionHtml.indexOf('<div class="animate-theme-list animate-wish">');

  if (wishIndex >= 0) {
    sectionHtml = sectionHtml.slice(0, wishIndex);
  }

  const resultBlocks =
    sectionHtml.match(/<a href='animeRef\.php\?sn=\d+' class='theme-list-main'[\s\S]*?<\/a>/g) ?? [];

  const parsed = resultBlocks
    .map((block) => {
      const animeSn = Number(extractMatch(block, /animeRef\.php\?sn=(\d+)/));
      const title = extractMatch(block, /<p class='theme-name'>([\s\S]*?)<\/p>/);
      const yearLabel = extractMatch(block, /<p class='theme-time'>年份：([\s\S]*?)<\/p>/);
      const episodeCount = Number(extractMatch(block, /共(\d+)集/));
      const viewText = extractMatch(
        block,
        /<div class='show-view-number'>[\s\S]*?<p>([\s\S]*?)<\/p>/,
      );
      const coverUrl = normalizeUrl(extractMatch(block, /data-src='([^']+)'/));
      const editionTags = [...block.matchAll(/<span class='label-[^']*'>([\s\S]*?)<\/span>/g)].map(
        (match) => cleanHtmlText(match[1]),
      );

      return {
        animeSn,
        title,
        yearLabel,
        episodeCount: Number.isFinite(episodeCount) ? episodeCount : 0,
        viewText,
        coverUrl,
        editionTags,
      };
    })
    .filter((item) => item.animeSn > 0 && item.title);

  return uniqueBy(parsed, (item) => item.animeSn);
}

function parseSeriesGroups(html) {
  const sectionMatches = [...html.matchAll(/<section class="season">([\s\S]*?)<\/section>/g)];

  if (sectionMatches.length === 0) {
    return [];
  }

  const groups = [];

  for (const sectionMatch of sectionMatches) {
    const listMatches = [
      ...sectionMatch[1].matchAll(/(?:<p[^>]*>([\s\S]*?)<\/p>\s*)?<ul>([\s\S]*?)<\/ul>/g),
    ];

    listMatches.forEach((match, groupIndex) => {
      const rawLabel = cleanHtmlText(match[1] ?? '');
      const label =
        rawLabel || (listMatches.length === 1 && sectionMatches.length === 1 ? '剧集' : `分组 ${groupIndex + 1}`);
      const listHtml = match[2];
      const episodes = [...listHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
        .map((episodeMatch, index) => {
          const attrs = episodeMatch[1];
          const hrefMatch = attrs.match(/href=["'][^"']*\?sn=(\d+)["']/);
          const videoSnMatch = attrs.match(/data-ani-video-sn=["'](\d+)["']/);
          const videoSn = Number(videoSnMatch?.[1] || hrefMatch?.[1] || 0);

          return {
            videoSn,
            label: cleanHtmlText(episodeMatch[2]),
            order: index + 1,
            groupLabel: label,
          };
        })
        .filter((episode) => episode.videoSn > 0);

      if (episodes.length > 0) {
        groups.push({
          label,
          episodes,
        });
      }
    });
  }

  return groups;
}

function parseSeriesDetail(html, animeSn) {
  const title =
    extractMatch(html, /<img data-src="[^"]+" alt="([^"]+)" class="data-img lazyload">/) ||
    extractMatch(html, /<div class="anime_name">\s*<h1>([\s\S]*?)<\/h1>/).replace(/\s*\[[^\]]+\]\s*$/, '');
  const coverUrl = normalizeUrl(
    extractMatch(html, /<img data-src="([^"]+)" alt="[^"]*" class="data-img lazyload">/),
  );
  const currentVideoSn = Number(extractMatch(html, /animefun\.videoSn = (\d+);/)) || null;
  const groups = parseSeriesGroups(html);
  const primaryEpisodeCount = groups[0]?.episodes.length ?? 0;
  const totalSelectableCount = groups.reduce((sum, group) => sum + group.episodes.length, 0);

  return {
    animeSn,
    title,
    coverUrl,
    currentVideoSn,
    primaryEpisodeCount,
    totalSelectableCount,
    groups,
  };
}

async function fetchBahamutSeriesDetail(animeSn) {
  const html = await fetchHtml(`${ANI_ROOT}/animeRef.php?sn=${animeSn}`, {
    headers: createHeaders(`${ANI_ROOT}/search.php`),
  });

  return parseSeriesDetail(html, animeSn);
}

module.exports = {
  fetchBahamutSeriesDetail,
  parseSearchResults,
};
