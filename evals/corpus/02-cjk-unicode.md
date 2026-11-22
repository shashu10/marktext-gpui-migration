# 多语言文档测试 — CJK & Accented Slugs (#5292)

你好 world！这是一个测试文档，用于验证 MarkText 的中文字数统计和 Unicode 标题锚点生成。

## Café Résumé & Naïve Parsing

Testing accented characters, punctuation!@#$%^&*(), and multiple   spaces   between words.

### 日本語の見出しテスト 2026

- [x] Verify CJK character counting matches `[\u4E00-\u9FA5]`
- [ ] Verify emoji & surrogate pairs UTF-16 length parity 🚀🔥

> Mixed paragraph with 中文字符 and English tokens.


Extra blank lines above should still count paragraphs cleanly.
