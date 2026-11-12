const list = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
const text = value => typeof value === 'string' ? value.slice(0, 2000) : '';
const mediaHost = host => host === 'lookaside.facebook.com' || ['fbcdn.net', 'cdninstagram.com', 'fbsbx.com'].some(domain => host === domain || host.endsWith('.' + domain));

// Return only usable HTTPS URLs, never bearer tokens, arbitrary payloads or executable schemes.
export function instagramContentUrl(value, mediaOnly = false) {
  if (typeof value !== 'string' || value.length > 12000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        [...url.searchParams.keys()].some(k => /^(access_token|appsecret_proof|client_secret)$/i.test(k)) ||
        (mediaOnly && !mediaHost(url.hostname))) return null;
    return url.toString();
  } catch { return null; }
}

export function instagramMessageContent(message) {
  const attachments = [];
  for (const a of list(message.attachments).slice(0, 20)) {
    const mime = text(a.mime_type).toLowerCase();
    const declared = text(a.type).toLowerCase();
    const image = a.image_data || {};
    const video = a.video_data || {};
    const audio = a.audio_data || {};
    const type = a.audio_data || mime.startsWith('audio/') || declared === 'audio' ? 'audio'
      : a.image_data || mime.startsWith('image/') || declared === 'image' ? 'image'
      : a.video_data || mime.startsWith('video/') || declared === 'video' ? 'video'
        : 'file';
    const url = instagramContentUrl(type === 'image' ? image.url || image.preview_url || a.file_url || a.url || a.payload?.url
      : type === 'video' ? video.url || a.file_url || a.url || a.payload?.url
        : type === 'audio' ? audio.url || a.file_url || a.url || a.payload?.url : a.file_url || a.url || a.payload?.url, true);
    attachments.push({ type, url, previewUrl: instagramContentUrl(video.preview_url || image.preview_url, true),
      title: text(a.name || a.filename) });
  }
  if (message.sticker) attachments.push({ type: 'sticker', url: instagramContentUrl(typeof message.sticker === 'object' ? message.sticker.url : message.sticker, true), previewUrl: null, title: '' });
  const shares = list(message.shares).slice(0, 20).map(s => ({
    type: 'share', url: instagramContentUrl(s.link || s.url), title: text(s.name || s.title || s.description),
    previewUrl: instagramContentUrl(s.picture || s.image_url, true)
  }));
  if (message.story && typeof message.story === 'object') shares.push({
    type: 'story', url: instagramContentUrl(message.story.link || message.story.url),
    title: text(message.story.title), previewUrl: instagramContentUrl(message.story.image_url, true)
  });
  const reactions = Object.entries(list(message.reactions).slice(0, 100).reduce((counts, r) => {
    const emoji = text(r.emoji || r.reaction).slice(0, 32);
    if (emoji) counts[emoji] = (counts[emoji] || 0) + 1;
    return counts;
  }, Object.create(null))).map(([emoji, count]) => ({ emoji, count }));
  const textContent = typeof message.message === 'string' ? message.message : '';
  const unsupported = message.is_unsupported === true;
  const contentUnavailable = !textContent && !attachments.length && !shares.length && !reactions.length;
  return { text_content: textContent, attachments, shares, reactions, has_attachments: attachments.length > 0,
    contentUnavailable, unsupported };
}

export function instagramMessagePreview(message) {
  const c = instagramMessageContent(message || {});
  if (c.text_content) return c.text_content;
  if (c.shares.length) return c.shares[0].type === 'story' ? 'История Instagram' : 'Публикация или ссылка';
  if (c.attachments.length) return ({ image: 'Фото / GIF', video: 'Видео', audio: 'Голосовое / аудио', sticker: 'Стикер', file: 'Файл' })[c.attachments[0].type];
  if (c.reactions.length) return c.reactions.map(r => r.emoji).join(' ');
  return 'Содержимое недоступно в API Instagram';
}
