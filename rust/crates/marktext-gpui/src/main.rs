use gpui::{
    div, prelude::*, px, rgb, size, App, Application, Bounds, Context, SharedString,
    TitlebarOptions, Window, WindowBounds, WindowOptions,
};
use marktext_core::flags::{find_repo_root, load_flags_for_env};
use marktext_core::{
    extract_outline, parse_blocks, word_count, MarkdownBlock, MigrationFlags, MigrationMode,
    TocEntry, WordCount,
};
use std::path::{Path, PathBuf};
use std::time::Instant;

const BG_CANVAS: u32 = 0x0f172a;
const BG_PANEL: u32 = 0x111c33;
const BG_ELEVATED: u32 = 0x1e293b;
const BG_ACTIVE: u32 = 0x1d4ed8;
const BORDER_SUBTLE: u32 = 0x263449;
const TEXT_PRIMARY: u32 = 0xf1f5f9;
const TEXT_MUTED: u32 = 0x94a3b8;
const TEXT_DIM: u32 = 0x64748b;

const EMERALD_BG: u32 = 0x064e3b;
const EMERALD_BORDER: u32 = 0x10b981;
const EMERALD_TEXT: u32 = 0x6ee7b7;

const AMBER_BG: u32 = 0x451a03;
const AMBER_BORDER: u32 = 0xf59e0b;
const AMBER_TEXT: u32 = 0xfcd34d;

const SLATE_BG: u32 = 0x1e293b;
const SLATE_BORDER: u32 = 0x475569;
const SLATE_TEXT: u32 = 0xcbd5e1;

const ENVIRONMENTS: [&str; 3] = ["dev", "staging", "prod"];
const TRACKED_COMPONENTS: [&str; 3] = ["word-count", "outline-toc", "markdown-blocks"];

struct MarkTextPreview {
    repo_root: Option<PathBuf>,
    document_path: String,
    markdown: String,
    lines: Vec<String>,
    outline: Vec<TocEntry>,
    stats: WordCount,
    parse_duration_us: u128,
    active_env: String,
    flags: MigrationFlags,
    flag_error: Option<String>,
    selected_heading_idx: Option<usize>,
    rust_blocks: Result<Vec<MarkdownBlock>, String>,
}

impl MarkTextPreview {
    fn new(document_path: PathBuf, initial_env: String, repo_root: Option<PathBuf>) -> Self {
        let markdown = std::fs::read_to_string(&document_path).unwrap_or_else(|err| {
            format!(
                "# Failed to load document\n\nCould not read `{}`: {err}\n",
                document_path.display()
            )
        });

        let start = Instant::now();
        let outline = extract_outline(&markdown);
        let stats = word_count(&markdown);
        let parse_duration_us = start.elapsed().as_micros();
        let rust_blocks = parse_blocks(&markdown);

        let lines = markdown.split('\n').map(ToOwned::to_owned).collect();
        let selected_heading_idx = if outline.is_empty() { None } else { Some(0) };

        let (flags, flag_error) = match load_flags_for_env(&initial_env, repo_root.as_deref()) {
            Ok(loaded) => (loaded, None),
            Err(err) => (fallback_flags(&initial_env), Some(err)),
        };

        let display_path = match &repo_root {
            Some(root) => document_path
                .strip_prefix(root)
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| document_path.display().to_string()),
            None => document_path.display().to_string(),
        };

        Self {
            repo_root,
            document_path: display_path,
            markdown,
            lines,
            outline,
            stats,
            parse_duration_us,
            active_env: initial_env,
            flags,
            flag_error,
            selected_heading_idx,
            rust_blocks,
        }
    }

    fn switch_environment(&mut self, env: &str) {
        self.active_env = env.to_string();
        match load_flags_for_env(env, self.repo_root.as_deref()) {
            Ok(loaded) => {
                self.flags = loaded;
                self.flag_error = None;
            }
            Err(err) => {
                self.flags = fallback_flags(env);
                self.flag_error = Some(err);
            }
        }
        // Re-evaluate blocks in case feature flags or runtime state changed.
        self.rust_blocks = parse_blocks(&self.markdown);
    }

    fn select_heading(&mut self, index: usize) {
        if index < self.outline.len() {
            self.selected_heading_idx = Some(index);
        }
    }

    fn selected_line(&self) -> Option<usize> {
        self.selected_heading_idx
            .and_then(|idx| self.outline.get(idx))
            .map(|entry| entry.line)
    }

    fn is_markdown_blocks_migrated(&self) -> bool {
        self.flags.mode_for("markdown-blocks") == MigrationMode::Migrated
            && self.rust_blocks.is_ok()
    }

    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let active_env = self.active_env.clone();

        let env_buttons = ENVIRONMENTS.into_iter().map(|env_name| {
            let is_active = active_env == env_name;
            let env_owned = env_name.to_string();
            let id = SharedString::from(format!("env-btn-{env_name}"));

            div()
                .id(id)
                .px_3()
                .py_1()
                .rounded_md()
                .border_1()
                .cursor_pointer()
                .text_xs()
                .bg(rgb(if is_active { BG_ACTIVE } else { BG_ELEVATED }))
                .border_color(rgb(if is_active { 0x3b82f6 } else { BORDER_SUBTLE }))
                .text_color(rgb(if is_active { TEXT_PRIMARY } else { TEXT_MUTED }))
                .hover(|style| style.bg(rgb(if is_active { BG_ACTIVE } else { 0x334155 })))
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    this.switch_environment(&env_owned);
                    cx.notify();
                }))
                .child(env_name.to_uppercase())
        });

        let status_pills = TRACKED_COMPONENTS.into_iter().map(|component| {
            let mode = self.flags.mode_for(component);
            let (bg, border, text_color) = mode_colors(mode);

            div()
                .flex()
                .items_center()
                .gap_1()
                .px_2()
                .py_1()
                .rounded_md()
                .border_1()
                .bg(rgb(bg))
                .border_color(rgb(border))
                .text_xs()
                .text_color(rgb(text_color))
                .child(format!("{component}: {}", mode.as_str()))
        });

        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap_4()
            .px_4()
            .py_3()
            .bg(rgb(BG_PANEL))
            .border_b_1()
            .border_color(rgb(BORDER_SUBTLE))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .child(
                        div()
                            .text_sm()
                            .text_color(rgb(TEXT_PRIMARY))
                            .child("MarkText GPUI — Messy Middle"),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(rgb(TEXT_DIM))
                            .child(format!("Document: {}", self.document_path)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_1()
                            .child(div().text_xs().text_color(rgb(TEXT_DIM)).mr_1().child("ENV"))
                            .children(env_buttons),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .children(status_pills),
                    ),
            )
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let outline_mode = self.flags.mode_for("outline-toc");
        let selected_idx = self.selected_heading_idx;

        let items = self.outline.iter().enumerate().map(|(idx, entry)| {
            let is_selected = selected_idx == Some(idx);
            let indent = (entry.level.saturating_sub(1) as f32) * 12.0;
            let id = SharedString::from(format!("toc-entry-{idx}"));

            div()
                .id(id)
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap_2()
                .pl(px(10.0 + indent))
                .pr_2()
                .py_1p5()
                .rounded_md()
                .cursor_pointer()
                .bg(rgb(if is_selected { BG_ACTIVE } else { BG_PANEL }))
                .hover(|style| style.bg(rgb(if is_selected { BG_ACTIVE } else { BG_ELEVATED })))
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    this.select_heading(idx);
                    cx.notify();
                }))
                .child(
                    div()
                        .text_xs()
                        .text_color(rgb(if is_selected {
                            TEXT_PRIMARY
                        } else {
                            SLATE_TEXT
                        }))
                        .truncate()
                        .child(format!("H{} {}", entry.level, entry.text)),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(rgb(if is_selected { TEXT_PRIMARY } else { TEXT_DIM }))
                        .child(format!("L{}", entry.line + 1)),
                )
        });

        div()
            .w(px(260.0))
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(BG_PANEL))
            .border_r_1()
            .border_color(rgb(BORDER_SUBTLE))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(rgb(BORDER_SUBTLE))
                    .child(
                        div()
                            .text_xs()
                            .text_color(rgb(TEXT_MUTED))
                            .child(format!("OUTLINE ({})", self.outline.len())),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(rgb(mode_colors(outline_mode).2))
                            .child(outline_mode.as_str()),
                    ),
            )
            .child(
                div()
                    .id("outline-scroll")
                    .flex_1()
                    .overflow_y_scroll()
                    .p_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .children(items),
            )
    }

    fn render_document_pane(&self) -> impl IntoElement {
        let blocks_mode = self.flags.mode_for("markdown-blocks");
        let is_migrated = self.is_markdown_blocks_migrated();
        let selected_line = self.selected_line();

        let (banner_bg, banner_border, banner_text, banner_title, banner_detail) = if is_migrated {
            (
                EMERALD_BG,
                EMERALD_BORDER,
                EMERALD_TEXT,
                "markdown-blocks: MIGRATED (Rust)",
                "Rendering native GFM AST blocks from marktext_core::markdown_blocks::parse_blocks().".to_string(),
            )
        } else {
            let reason = match &self.rust_blocks {
                Err(msg) => msg.clone(),
                Ok(_) => format!(
                    "Environment '{}' routes markdown-blocks via mode '{}' (engine: {}).",
                    self.active_env,
                    blocks_mode.as_str(),
                    self.flags.engine_for("markdown-blocks")
                ),
            };
            (
                AMBER_BG,
                AMBER_BORDER,
                AMBER_TEXT,
                "markdown-blocks: LEGACY (Fallback)",
                reason,
            )
        };

        let mut content = div()
            .id("doc-scroll")
            .flex_1()
            .overflow_y_scroll()
            .p_4()
            .flex()
            .flex_col()
            .gap_1();

        if is_migrated {
            if let Ok(blocks) = &self.rust_blocks {
                for block in blocks {
                    content = content.child(render_migrated_block(block));
                }
            }
        } else {
            for (idx, line) in self.lines.iter().enumerate() {
                let is_highlighted = selected_line == Some(idx);
                content = content.child(
                    div()
                        .flex()
                        .flex_row()
                        .gap_3()
                        .px_2()
                        .py_0p5()
                        .rounded_sm()
                        .bg(rgb(if is_highlighted {
                            0x1e3a5f
                        } else {
                            BG_CANVAS
                        }))
                        .child(
                            div()
                                .w(px(36.0))
                                .text_xs()
                                .text_color(rgb(if is_highlighted {
                                    0x60a5fa
                                } else {
                                    TEXT_DIM
                                }))
                                .child(format!("{:>3}", idx + 1)),
                        )
                        .child(
                            div()
                                .flex_1()
                                .text_sm()
                                .text_color(rgb(if line.starts_with('#') {
                                    0x93c5fd
                                } else {
                                    TEXT_PRIMARY
                                }))
                                .child(if line.is_empty() {
                                    " ".to_string()
                                } else {
                                    line.clone()
                                }),
                        ),
                );
            }
        }

        let mut pane = div()
            .flex_1()
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(BG_CANVAS))
            .child(
                div()
                    .mx_4()
                    .mt_3()
                    .mb_1()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .border_1()
                    .bg(rgb(banner_bg))
                    .border_color(rgb(banner_border))
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .child(
                        div()
                            .text_xs()
                            .text_color(rgb(banner_text))
                            .child(banner_title),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(rgb(TEXT_PRIMARY))
                            .child(banner_detail),
                    ),
            );

        if let Some(err) = &self.flag_error {
            pane = pane.child(
                div()
                    .mx_4()
                    .mb_1()
                    .px_3()
                    .py_1()
                    .rounded_md()
                    .bg(rgb(0x450a0a))
                    .text_xs()
                    .text_color(rgb(0xfca5a5))
                    .child(format!("Flag load fallback: {err}")),
            );
        }

        pane.child(content)
    }

    fn render_status_bar(&self) -> impl IntoElement {
        let wc_mode = self.flags.mode_for("word-count");

        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px_4()
            .py_2()
            .bg(rgb(BG_PANEL))
            .border_t_1()
            .border_color(rgb(BORDER_SUBTLE))
            .text_xs()
            .text_color(rgb(TEXT_MUTED))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_4()
                    .child(format!("Words: {}", self.stats.word))
                    .child(format!("Chars: {}", self.stats.character))
                    .child(format!("Paragraphs: {}", self.stats.paragraph))
                    .child(format!("All: {}", self.stats.all)),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_4()
                    .child(format!(
                        "word-count: {} ({})",
                        wc_mode.as_str(),
                        self.flags.engine_for("word-count")
                    ))
                    .child(
                        div()
                            .text_color(rgb(EMERALD_TEXT))
                            .child(format!("Rust parse: {} µs", self.parse_duration_us)),
                    ),
            )
    }
}

impl Render for MarkTextPreview {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(BG_CANVAS))
            .text_color(rgb(TEXT_PRIMARY))
            .child(self.render_header(cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_row()
                    .child(self.render_sidebar(cx))
                    .child(self.render_document_pane()),
            )
            .child(self.render_status_bar())
    }
}

fn render_migrated_block(block: &MarkdownBlock) -> impl IntoElement {
    match block {
        MarkdownBlock::Heading { level, text } => div()
            .py_1()
            .text_color(rgb(0x93c5fd))
            .child(format!("{} {}", "#".repeat((*level).max(1) as usize), text)),
        MarkdownBlock::CodeFence { lang, code } => div()
            .my_1()
            .p_2()
            .rounded_md()
            .bg(rgb(BG_ELEVATED))
            .border_1()
            .border_color(rgb(BORDER_SUBTLE))
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(TEXT_DIM))
                    .child(if lang.is_empty() { "code" } else { lang.as_str() }.to_string()),
            )
            .child(div().text_xs().text_color(rgb(TEXT_PRIMARY)).child(code.clone())),
        MarkdownBlock::TaskItem { checked, text } => div()
            .py_0p5()
            .text_sm()
            .text_color(rgb(if *checked { EMERALD_TEXT } else { TEXT_PRIMARY }))
            .child(format!("{} {}", if *checked { "[x]" } else { "[ ]" }, text)),
        MarkdownBlock::Blockquote { text } => div()
            .my_1()
            .pl_3()
            .py_1()
            .border_l_2()
            .border_color(rgb(0x3b82f6))
            .text_sm()
            .text_color(rgb(TEXT_MUTED))
            .child(text.clone()),
        MarkdownBlock::Hr => div().my_2().h(px(1.0)).w_full().bg(rgb(BORDER_SUBTLE)),
        MarkdownBlock::Paragraph { text } => {
            div().py_0p5().text_sm().text_color(rgb(TEXT_PRIMARY)).child(text.clone())
        }
    }
}

fn mode_colors(mode: MigrationMode) -> (u32, u32, u32) {
    match mode {
        MigrationMode::Migrated => (EMERALD_BG, EMERALD_BORDER, EMERALD_TEXT),
        MigrationMode::Shadow => (AMBER_BG, AMBER_BORDER, AMBER_TEXT),
        MigrationMode::Legacy => (SLATE_BG, SLATE_BORDER, SLATE_TEXT),
    }
}

fn fallback_flags(env: &str) -> MigrationFlags {
    MigrationFlags {
        environment: env.to_string(),
        description: "Fallback defaults (config file unavailable)".to_string(),
        components: Default::default(),
    }
}

fn resolve_default_document(repo_root: Option<&Path>) -> PathBuf {
    if let Some(arg_path) = std::env::args().nth(1) {
        return PathBuf::from(arg_path);
    }

    let relative = Path::new("evals/corpus/01-enterprise-spec.md");
    if let Some(root) = repo_root {
        let candidate = root.join(relative);
        if candidate.is_file() {
            return candidate;
        }
    }

    relative.to_path_buf()
}

fn resolve_repo_root() -> Option<PathBuf> {
    std::env::current_dir()
        .ok()
        .and_then(|dir| find_repo_root(&dir))
        .or_else(|| find_repo_root(Path::new(env!("CARGO_MANIFEST_DIR"))))
}

fn main() {
    let repo_root = resolve_repo_root();
    let doc_path = resolve_default_document(repo_root.as_deref());
    let initial_env = std::env::var("MIGRATION_ENV").unwrap_or_else(|_| "dev".to_string());

    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1120.0), px(740.0)), cx);
        let doc_path = doc_path.clone();
        let initial_env = initial_env.clone();
        let repo_root = repo_root.clone();

        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("MarkText GPUI — Mid-Migration Preview".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            move |_, cx| cx.new(|_| MarkTextPreview::new(doc_path, initial_env, repo_root)),
        )
        .expect("open MarkText GPUI window");
        cx.activate(true);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    fn sample_doc_path() -> (Option<PathBuf>, PathBuf) {
        let root = resolve_repo_root();
        let doc = root
            .as_ref()
            .expect("locate repo root")
            .join("evals/corpus/01-enterprise-spec.md");
        (root, doc)
    }

    #[test]
    fn preview_state_loads_corpus_and_switches_environments() {
        let (root, doc) = sample_doc_path();
        let mut view = MarkTextPreview::new(doc, "dev".to_string(), root);

        assert!(view.flag_error.is_none());
        assert_eq!(view.active_env, "dev");
        assert_eq!(view.flags.mode_for("word-count"), MigrationMode::Migrated);
        assert_eq!(view.flags.mode_for("outline-toc"), MigrationMode::Migrated);
        assert_eq!(
            view.flags.mode_for("markdown-blocks"),
            MigrationMode::Legacy
        );
        assert!(!view.is_markdown_blocks_migrated());
        assert_eq!(view.outline.len(), 6);
        assert!(view.stats.word > 100);
        assert_eq!(view.selected_line(), Some(0));

        // Switch to staging and verify outline-toc transitions to shadow mode.
        view.switch_environment("staging");
        assert!(view.flag_error.is_none());
        assert_eq!(view.flags.mode_for("outline-toc"), MigrationMode::Shadow);

        // Switch to prod and verify word-count is shadow and outline-toc is legacy.
        view.switch_environment("prod");
        assert!(view.flag_error.is_none());
        assert_eq!(view.flags.mode_for("word-count"), MigrationMode::Shadow);
        assert_eq!(view.flags.mode_for("outline-toc"), MigrationMode::Legacy);

        // Select heading index 3 ("Legacy Setext Section" at 0-based line 29).
        view.select_heading(3);
        assert_eq!(view.selected_line(), Some(29));
    }

    #[gpui::test]
    fn headless_gpui_renders_and_handles_state_transitions(cx: &mut TestAppContext) {
        let (root, doc) = sample_doc_path();
        let (view, cx) =
            cx.add_window_view(|_window, _cx| MarkTextPreview::new(doc, "dev".to_string(), root));

        // Verify initial render state in headless TestWindow.
        view.read_with(cx, |preview, _cx| {
            assert_eq!(preview.active_env, "dev");
            assert_eq!(preview.outline.len(), 6);
            assert!(!preview.is_markdown_blocks_migrated());
        });

        // Mutate environment and selected TOC heading inside GPUI context, then re-render.
        view.update(cx, |preview, cx| {
            preview.switch_environment("staging");
            preview.select_heading(4);
            cx.notify();
        });
        cx.run_until_parked();
        cx.refresh().expect("refresh headless GPUI window");

        view.read_with(cx, |preview, _cx| {
            assert_eq!(preview.active_env, "staging");
            assert_eq!(preview.flags.mode_for("outline-toc"), MigrationMode::Shadow);
            assert_eq!(preview.selected_line(), Some(34));
        });
    }
}
