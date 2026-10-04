/**
 * Platform-specific formatting rules and hook templates
 * Injected into AI prompts based on target platform
 */

// ============================================
// Digest/style formatting rules (appended to STYLES system prompt)
// ============================================

export const PLATFORM_RULES = {
  telegram: `FORMAT RULES:
- Dùng Telegram formatting: *bold*, _italic_
- KHÔNG dùng ## markdown headers
- Tối đa 4000 ký tự
- Giữ nhịp viết tự nhiên; đừng biến mỗi mục thành cùng một template`,

  facebook: `FORMAT RULES:
- Plain text only — no markdown, no HTML
- Optimal length: under 500 characters for engagement
- Friendly, slightly more formal than X
- End with a real question only when it fits the article
- Put link on its own line at the end`,
};

// ============================================
// Hook rules (drip mode single-article posts per platform)
// ============================================

export const HOOK_RULES = {
  telegram: {
    format: `QUY TẮC:
- Vietnglish tự nhiên, xen tiếng Anh như người làm IT Việt chat hàng ngày
- Dòng đầu là tiêu đề bài viết, dùng *bold*
- Sau tiêu đề là đúng 2-3 câu ngắn chỉ tóm tắt thông tin chính; không viết phân tích dài hoặc hot take
- Tổng nội dung không quá 700 ký tự để vừa một Telegram photo caption
- Link gốc ở cuối, paste thẳng URL
- Emoji: tối đa 1 cái hoặc không
- Ngoài tiêu đề, không lạm dụng *bold*
- KHÔNG bắt đầu bằng emoji, KHÔNG dùng ## headers
- Tránh mở bài kiểu template: "Trong bối cảnh...", "Điều này quan trọng vì...", "Đây có thể là bước ngoặt..."`,
    examples: `VÍ DỤ TONE ĐÚNG (học cách viết, KHÔNG copy):

---
*Cloudflare giới thiệu Agent Lee cho AI agents trên edge*

Agent Lee gom Workers, KV, D1 và R2 vào cùng một flow triển khai AI agents. Cách tiếp cận này giúp team giảm phần glue code khi xây dựng trên Cloudflare stack.

https://blog.cloudflare.com/introducing-agent-lee/
---`,
  },

  facebook: {
    format: `RULES:
- Plain text only — NO markdown
- 300-500 characters optimal
- Vietnglish friendly tone, slightly more formal than X
- Summarize the key insight with one concrete implication
- End with a question only if it is specific and useful
- Link on its own line
- End with "— Dan Tech Content Radar"`,
    examples: `EXAMPLE TONE (learn style, DON'T copy):

---
Cloudflare vừa ra mắt Agent Lee, một flow mới để build AI agents trên Workers stack. Điểm đáng chú ý là KV, D1, R2 được kéo vào cùng runtime, nên phần glue code và vận hành có thể giảm khá nhiều.

Với team IT, tradeoff giữa tốc độ triển khai, chi phí vận hành và lock-in nên được cân nhắc thế nào?

blog.cloudflare.com/agent-lee/
— Dan Tech Content Radar
---`,
  },
};
