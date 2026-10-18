import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Published reference text has no same-origin API/navigation authority and never fetches images. */
export function safeKnowledgeUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (
			!["https:", "http:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.origin === window.location.origin
		)
			return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}
export function KnowledgeMarkdown({ markdown }: { markdown: string }) {
	return (
		<div className="space-y-2 break-words text-sm text-text-primary [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-surface-0 [&_pre]:p-2 [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:border-border-bright [&_blockquote]:pl-3 [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:border-border [&_td]:p-1 [&_th]:border [&_th]:border-border [&_th]:p-1">
			<Markdown
				skipHtml
				remarkPlugins={[remarkGfm]}
				urlTransform={safeKnowledgeUrl}
				components={{
					a: ({ href, children }) =>
						href ? (
							<a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline">
								{children}
							</a>
						) : (
							<span>{children}</span>
						),
					img: ({ alt }) => <span className="text-text-tertiary">[Image not loaded{alt ? `: ${alt}` : ""}]</span>,
					input: () => null,
				}}
			>
				{markdown}
			</Markdown>
		</div>
	);
}
