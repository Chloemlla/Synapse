// 工单票面字段（类型 / 相关服务 / 附件规则 / 附件链接）的展示口径与本地预校验。
//
// 为什么单独钉一条：
// 1. 相关服务的清单必须与后端 `src/models/ticketModel.ts` 的 TICKET_RELATED_SERVICES 一致 ——
//    后端对非法值**静默回退 other**，漂移不会报错，只会让用户选的服务被悄悄改掉；
// 2. 附件规则（白名单 / 1MB / ASCII 文件名 / 仅 http(s) 链接）是安全边界的镜像，
//    前端提前拦不当事，但拦错了会让用户反复白试。
import { describe, expect, it } from 'vitest';
import {
  MAX_TICKET_ATTACHMENT_BYTES,
  MAX_TICKET_ATTACHMENT_LINK_LEN,
  MAX_TICKET_ATTACHMENT_LINKS,
  TICKET_SERVICE_META,
  TICKET_SERVICE_ORDER,
  TICKET_TYPE_META,
  TICKET_TYPE_ORDER,
  attachmentLinkHost,
  formatAttachmentSize,
  normalizeTicketAttachmentLinkUrl,
  ticketServiceLabel,
  validateTicketAttachmentFile,
} from '../components/ticket/ticketConstants';

/** 与后端 TICKET_RELATED_SERVICES 保持同一份清单（漂移即失败）。 */
const BACKEND_SERVICES = [
  'tts',
  'transcribe',
  'librechat',
  'geogebra',
  'pixel',
  'lottery',
  'store',
  'articles',
  'shortlink',
  'outemail',
  'image-upload',
  'api',
  'account',
  'billing',
  'other',
];

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(Math.max(size, 1))], name, { type: 'application/octet-stream' });
}

describe('工单类型与相关服务的展示口径', () => {
  it('covers every backend service key exactly once, in the same order', () => {
    expect([...TICKET_SERVICE_ORDER]).toEqual(BACKEND_SERVICES);
    expect(Object.keys(TICKET_SERVICE_META).sort()).toEqual([...BACKEND_SERVICES].sort());
  });

  it('labels types and falls back for unknown keys', () => {
    expect(TICKET_TYPE_ORDER).toEqual(['inquiry', 'incident']);
    expect(TICKET_TYPE_META.inquiry.label).toBe('咨询');
    expect(TICKET_TYPE_META.incident.label).toBe('故障');
    expect(ticketServiceLabel('tts')).toBe('语音合成');
    expect(ticketServiceLabel(undefined)).toBe('其他 / 不确定');
    expect(ticketServiceLabel('brand-new-module')).toBe('brand-new-module');
  });
});

describe('附件文件的本前端预校验', () => {
  it('accepts whitelisted extensions within the size limit', () => {
    for (const name of ['a.jpg', 'b.jpeg', 'c.png', 'd.gif', 'e.txt', 'f.pdf']) {
      expect(validateTicketAttachmentFile(makeFile(name, 1024))).toBeNull();
    }
  });

  it('rejects non-ASCII names, unsupported extensions and oversized files', () => {
    expect(validateTicketAttachmentFile(makeFile('截图.png', 1024))).toContain('不支持中文名称');
    expect(validateTicketAttachmentFile(makeFile('payload.exe', 1024))).toContain('不支持的附件类型');
    expect(validateTicketAttachmentFile(makeFile('.hidden.png', 1024))).not.toBeNull();
    expect(validateTicketAttachmentFile(makeFile('noext', 1024))).not.toBeNull();
    expect(validateTicketAttachmentFile(makeFile('big.png', MAX_TICKET_ATTACHMENT_BYTES + 1))).toBe(
      '单个附件不能超过 1MB',
    );
  });

  it('renders sizes the same way the backend does', () => {
    expect(formatAttachmentSize(512)).toBe('512B');
    expect(formatAttachmentSize(2048)).toBe('2KB');
    expect(formatAttachmentSize(MAX_TICKET_ATTACHMENT_BYTES)).toBe('1MB');
  });
});

describe('附件链接校验', () => {
  it('accepts http/https urls and normalises them', () => {
    const result = normalizeTicketAttachmentLinkUrl('  https://example.com/a.png  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe('https://example.com/a.png');
    expect(normalizeTicketAttachmentLinkUrl('http://example.com').ok).toBe(true);
  });

  it('rejects empty, malformed and dangerous protocols', () => {
    expect(normalizeTicketAttachmentLinkUrl('').ok).toBe(false);
    expect(normalizeTicketAttachmentLinkUrl('not a url').ok).toBe(false);
    expect(normalizeTicketAttachmentLinkUrl('javascript:alert(1)').ok).toBe(false);
    expect(normalizeTicketAttachmentLinkUrl('data:text/html;base64,PHNjcmlwdD4=').ok).toBe(false);
    expect(normalizeTicketAttachmentLinkUrl(`https://example.com/${'x'.repeat(MAX_TICKET_ATTACHMENT_LINK_LEN)}`).ok).toBe(
      false,
    );
  });

  it('exposes the host for compact rendering', () => {
    expect(attachmentLinkHost('https://img.example.com/a.png')).toBe('img.example.com');
    expect(attachmentLinkHost('garbage')).toBe('garbage');
  });

  it('keeps the documented limits', () => {
    expect(MAX_TICKET_ATTACHMENT_LINKS).toBe(5);
    expect(MAX_TICKET_ATTACHMENT_LINK_LEN).toBe(2048);
  });
});
