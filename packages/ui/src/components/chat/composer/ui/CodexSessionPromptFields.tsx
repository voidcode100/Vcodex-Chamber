import React from 'react';

export type CodexSessionPromptFieldsProps = {
  prompt: string;
  onChange: (value: string) => void;
};

/** Optional WindowsSender instruction saved with the session being created. */
export function CodexSessionPromptFields({ prompt, onChange }: CodexSessionPromptFieldsProps) {
  return (
    <div className="mb-2 grid gap-2 rounded-md border border-border/60 bg-muted/20 p-2 text-xs">
      <div className="font-medium text-foreground">此会话的 WindowsSender Prompt</div>
      <label className="grid gap-1 text-muted-foreground">
        <span>会话 Prompt（截图和录音共用，可选）</span>
        <textarea
          value={prompt}
          onChange={(event) => onChange(event.target.value)}
          placeholder="收到 WindowsSender 截图或录音时附加给 Codex 的指令"
          className="min-h-14 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          rows={2}
        />
      </label>
    </div>
  );
}
