// Standalone Webviews share the chat parser, sanitizer, Shiki worker and controls.
export { renderMarkdownSync, renderMarkdownBlocks } from './markdownCore';
export { decorateMarkdown, attachMarkdownInteractions, type DecorateContext } from './decorate';
export { renderMermaidSVG } from 'beautiful-mermaid';
