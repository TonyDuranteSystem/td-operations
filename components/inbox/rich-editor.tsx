'use client'

/**
 * The email reply editor (dev job bbc70ff8, step 2): a small rich-text editor with a formatting toolbar.
 *
 * What it can express is deliberately the SAME short list the server's sanitizer allows
 * (lib/inbox/rich-text-sanitize.ts): bold, italic, underline, bullet / numbered lists, four colours, left / centre
 * alignment, links. Font, size, line spacing and paragraph spacing are NOT per-selection — they are four message-level
 * choices (RichStyle) the SERVER applies to the whole email, so the editor only previews them.
 *
 * This component owns the editor and its toolbar and nothing else. The reply's text, recipients, attachments and AI
 * state stay in ComposeReply; this reports changes up through `onChange` and is driven through the handle.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import { ListItem } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { Mark } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import {
  AlignCenter,
  AlignLeft,
  Bold,
  Eraser,
  Italic,
  Link2,
  List,
  ListOrdered,
  Redo2,
  Underline as UnderlineIcon,
  Undo2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import {
  DEFAULT_RICH_STYLE,
  RICH_COLORS,
  RICH_FONTS,
  RICH_FONT_STACKS,
  RICH_LINES,
  RICH_PARAS,
  RICH_SIZES,
  checkLinkHref,
  isDefaultRichStyle,
  normalizeLinkInput,
  normalizeRichColor,
  type RichStyle,
} from '@/lib/inbox/rich-text'

export interface RichEditorHandle {
  /** The editor's HTML right now (synchronous — the send reads this, never a possibly-stale copy). */
  getHTML: () => string
  /** Replace everything (AI result, Undo, reset after send). Returns the editor's own normalised HTML. */
  applyHtml: (html: string) => string
  focus: () => void
  focusEnd: () => void
}

/** Enter makes a new item; Tab is left alone so it keeps moving focus (no accidental nested lists). */
const SingleEnterListItem = ListItem.extend({
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.commands.splitListItem(this.name) }
  },
})

/** A text colour limited to the four the server accepts. Anything pasted in that is not one of them loses its colour. */
const TextColor = Mark.create({
  name: 'textColor',
  addAttributes() {
    return { color: { default: null } }
  },
  parseHTML() {
    return [
      {
        tag: 'span',
        getAttrs: (el) => {
          const c = normalizeRichColor((el as HTMLElement).style.color)
          return c ? { color: c } : false
        },
      },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', { style: `color:${HTMLAttributes.color}` }, 0]
  },
})

const COLOR_NAMES: Record<(typeof RICH_COLORS)[number], string> = {
  '#1f2937': 'Dark',
  '#2563eb': 'Blue',
  '#b91c1c': 'Red',
  '#15803d': 'Green',
}

const SIZE_NAMES: Record<keyof typeof RICH_SIZES, string> = { small: 'Small', normal: 'Normal', large: 'Large', huge: 'Huge' }
const LINE_NAMES: Record<keyof typeof RICH_LINES, string> = { tight: 'Tight', normal: 'Normal', airy: 'Relaxed', double: 'Double' }
const PARA_NAMES: Record<keyof typeof RICH_PARAS, string> = { none: 'None', small: 'Small', medium: 'Medium', large: 'Large' }

interface RichEditorProps {
  /** The editor's starting HTML (read once when it mounts; later changes go through the handle). */
  initialHtml: string
  style: RichStyle
  onStyleChange: (style: RichStyle) => void
  /** 'slim' = the few everyday buttons, 'full' = everything, null = no toolbar. */
  toolbar: 'slim' | 'full' | null
  /** Reports every change. `user` is false for a change we made ourselves (AI result, Undo, reset). */
  onChange: (html: string, user: boolean) => void
  onFocus: () => void
  /** Cmd/Ctrl+Enter. */
  onSend: () => void
  /** A screenshot or a copied file pasted with no text: attach it. */
  onPasteFiles: (files: File[]) => void
  placeholder: string
  /** Box classes for the writing surface itself (border, padding, min/max height). */
  surfaceClassName: string
  /** Grow to fill the parent (the pop-up). */
  fill?: boolean
  /** Put the cursor at the end as soon as the editor exists (the pop-up opening). */
  autoFocus?: boolean
}

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(props, ref) {
  const { initialHtml, style, onStyleChange, toolbar, surfaceClassName, fill, autoFocus } = props
  // Every callback goes through a ref: the editor is created once, so a closure captured then would go stale.
  const cb = useRef(props)
  cb.current = props
  const programmatic = useRef(false)
  const pendingHtml = useRef<string | null>(null)
  const lastHtml = useRef(initialHtml)

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    enableInputRules: false,
    enablePasteRules: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        dropcursor: false,
        trailingNode: false,
        listItem: false,
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: false,
          // The same rule the server applies: absolute http/https/mailto, never an internal address.
          isAllowedUri: (url: string) => checkLinkHref(url).ok,
        },
      }),
      SingleEnterListItem,
      TextColor,
      TextAlign.configure({ types: ['paragraph'], alignments: ['center'], defaultAlignment: null }),
      Placeholder.configure({ placeholder: () => cb.current.placeholder }),
    ],
    content: initialHtml || '',
    editorProps: {
      attributes: {
        // `compose-reply-textarea` stays on exactly ONE element: the inbox's Reply button finds the box by it.
        class: cn('compose-reply-textarea rich-editor-surface', surfaceClassName),
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Reply message',
        spellcheck: 'true',
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          cb.current.onSend()
          return true
        }
        return false
      },
      // Plain text keeps its blank lines. ProseMirror's own plain-text paste treats a run of newlines as ONE paragraph
      // break, so a pasted draft ("Dear Maria,", blank line, "Thanks…") would lose every blank line (the old textarea
      // kept them). One line becomes one paragraph, an empty line an empty paragraph — exactly what typing Enter makes.
      clipboardTextParser: (text, _context, _plain, view) => {
        const lines = text.replace(/\r\n?/g, '\n').split('\n')
        if (lines.length < 2) return null as unknown as Slice
        const { paragraph } = view.state.schema.nodes
        const nodes = lines.map((l) => paragraph.create(null, l ? view.state.schema.text(l) : undefined))
        return new Slice(Fragment.from(nodes), 1, 1)
      },
      handlePaste: (_view, event) => {
        const data = event.clipboardData
        if (!data) return false
        const files = Array.from(data.files ?? [])
        // A screenshot / a copied file arrives as a file with no text: attach it instead of pasting nothing.
        if (files.length > 0 && !data.getData('text/plain') && !data.getData('text/html')) {
          event.preventDefault()
          cb.current.onPasteFiles(files)
          return true
        }
        return false
      },
    },
    onCreate: ({ editor: ed }) => {
      if (pendingHtml.current !== null) {
        const html = pendingHtml.current
        pendingHtml.current = null
        programmatic.current = true
        ed.commands.setContent(html, { emitUpdate: true })
        programmatic.current = false
      }
      if (autoFocus) ed.commands.focus('end')
    },
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML()
      lastHtml.current = html
      cb.current.onChange(html, !programmatic.current)
    },
    onFocus: () => cb.current.onFocus(),
  })

  useImperativeHandle(
    ref,
    () => ({
      getHTML: () => (editor ? editor.getHTML() : pendingHtml.current ?? lastHtml.current),
      applyHtml: (html: string) => {
        if (!editor) {
          pendingHtml.current = html
          return html
        }
        programmatic.current = true
        editor.commands.setContent(html, { emitUpdate: true })
        programmatic.current = false
        return editor.getHTML()
      },
      focus: () => editor?.commands.focus(),
      focusEnd: () => editor?.commands.focus('end'),
    }),
    [editor],
  )

  return (
    <div className={cn('flex flex-col', fill && 'min-h-0 flex-1')}>
      {toolbar && editor && <Toolbar editor={editor} variant={toolbar} style={style} onStyleChange={onStyleChange} />}
      {/* The message-level choices are previewed here by inheritance; the SERVER applies the real spacing. */}
      <div
        data-tour="reply-box"
        className={cn('rich-editor-wrap', fill && 'flex min-h-0 flex-1 flex-col')}
        style={
          {
            fontFamily: RICH_FONT_STACKS[style.font],
            fontSize: `${RICH_SIZES[style.size]}px`,
            lineHeight: RICH_LINES[style.line],
            '--rich-para': `${RICH_PARAS[style.para]}px`,
          } as React.CSSProperties
        }
      >
        <EditorContent editor={editor} className={cn(fill && 'flex min-h-0 flex-1 flex-col [&>div]:flex-1')} />
      </div>
    </div>
  )
})

// ─── Toolbar ────────────────────────────────────────────────────────────────────────────────────────────

function Toolbar({
  editor,
  variant,
  style,
  onStyleChange,
}: {
  editor: Editor
  variant: 'slim' | 'full'
  style: RichStyle
  onStyleChange: (style: RichStyle) => void
}) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)
  const full = variant === 'full'

  useEffect(() => {
    if (linkOpen) linkInputRef.current?.focus()
  }, [linkOpen])

  const openLink = () => {
    const current = editor.getAttributes('link').href as string | undefined
    setLinkValue(current ?? '')
    setLinkError(null)
    setLinkOpen(true)
  }
  const closeLink = () => {
    setLinkOpen(false)
    setLinkError(null)
    editor.chain().focus().run()
  }
  const applyLink = () => {
    const checked = checkLinkHref(normalizeLinkInput(linkValue))
    if ('reason' in checked) {
      setLinkError(checked.reason)
      return
    }
    const { from, to } = editor.state.selection
    if (from === to && !editor.isActive('link')) {
      // Nothing selected: the address itself becomes the link's words.
      editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: checked.href, marks: [{ type: 'link', attrs: { href: checked.href } }] })
        .run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: checked.href }).run()
    }
    setLinkOpen(false)
    setLinkError(null)
  }
  const removeLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    setLinkOpen(false)
    setLinkError(null)
  }

  const activeColor = RICH_COLORS.find((c) => editor.isActive('textColor', { color: c })) ?? null

  const btn = (label: string, active: boolean, onClick: () => void, icon: React.ReactNode, disabled = false) => (
    <FastTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        // The mouse press must not steal focus from the editor, or the selection the button acts on is lost.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors',
          'hover:bg-zinc-200 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40',
          active && 'bg-blue-100 text-blue-700 hover:bg-blue-100',
        )}
      >
        {icon}
      </button>
    </FastTooltip>
  )
  const sep = <span className="mx-0.5 h-5 w-px bg-zinc-200" aria-hidden="true" />

  const select = <K extends keyof RichStyle>(
    key: K,
    label: string,
    options: Array<[string, string]>,
    extraClass?: string,
  ) => (
    <label className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
      {label}
      <select
        value={style[key] as string}
        onChange={(e) => onStyleChange({ ...style, [key]: e.target.value } as RichStyle)}
        aria-label={label}
        className={cn('h-8 rounded-md border border-zinc-200 bg-white px-1.5 text-xs text-zinc-700', extraClass)}
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <div className="mb-1.5 space-y-1.5">
      <div role="toolbar" aria-label="Formatting" data-tour="reply-toolbar" className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {full && (
          <>
            {select('font', 'Font', RICH_FONTS.map((f) => [f, f] as [string, string]), 'max-w-[8.5rem]')}
            {select('size', 'Size', (Object.keys(RICH_SIZES) as Array<keyof typeof RICH_SIZES>).map((k) => [k, SIZE_NAMES[k]]))}
            {select('line', 'Line', (Object.keys(RICH_LINES) as Array<keyof typeof RICH_LINES>).map((k) => [k, LINE_NAMES[k]]))}
            {select('para', 'Gap', (Object.keys(RICH_PARAS) as Array<keyof typeof RICH_PARAS>).map((k) => [k, PARA_NAMES[k]]))}
            {!isDefaultRichStyle(style) && (
              <button
                type="button"
                onClick={() => onStyleChange({ ...DEFAULT_RICH_STYLE })}
                className="text-[11px] text-zinc-500 underline decoration-dotted hover:text-zinc-800"
              >
                Reset
              </button>
            )}
            {sep}
          </>
        )}
        {btn('Bold (⌘B)', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), <Bold className="h-4 w-4" />)}
        {btn('Italic (⌘I)', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), <Italic className="h-4 w-4" />)}
        {btn('Underline (⌘U)', editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run(), <UnderlineIcon className="h-4 w-4" />)}
        {full && (
          <>
            {sep}
            <span className="inline-flex items-center gap-1" role="group" aria-label="Text colour">
              {RICH_COLORS.map((c) => (
                <FastTooltip key={c} label={`${COLOR_NAMES[c]} text`}>
                  <button
                    type="button"
                    aria-label={`${COLOR_NAMES[c]} text`}
                    aria-pressed={activeColor === c}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() =>
                      activeColor === c
                        ? editor.chain().focus().unsetMark('textColor').run()
                        : editor.chain().focus().setMark('textColor', { color: c }).run()
                    }
                    className={cn(
                      'h-5 w-5 rounded-full ring-offset-1 transition',
                      activeColor === c ? 'ring-2 ring-blue-500' : 'ring-1 ring-zinc-300 hover:ring-zinc-500',
                    )}
                    style={{ backgroundColor: c }}
                  />
                </FastTooltip>
              ))}
            </span>
          </>
        )}
        {sep}
        {btn('Bulleted list', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), <List className="h-4 w-4" />)}
        {btn('Numbered list', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), <ListOrdered className="h-4 w-4" />)}
        {full && (
          <>
            {btn('Align left', !editor.isActive({ textAlign: 'center' }), () => editor.chain().focus().unsetTextAlign().run(), <AlignLeft className="h-4 w-4" />)}
            {btn('Centre', editor.isActive({ textAlign: 'center' }), () => editor.chain().focus().setTextAlign('center').run(), <AlignCenter className="h-4 w-4" />)}
          </>
        )}
        {sep}
        {btn('Link', editor.isActive('link') || linkOpen, openLink, <Link2 className="h-4 w-4" />)}
        {full && (
          <>
            {btn(
              'Clear formatting',
              false,
              () => editor.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().run(),
              <Eraser className="h-4 w-4" />,
            )}
            {sep}
            {btn('Undo (⌘Z)', false, () => editor.chain().focus().undo().run(), <Undo2 className="h-4 w-4" />, !editor.can().undo())}
            {btn('Redo (⇧⌘Z)', false, () => editor.chain().focus().redo().run(), <Redo2 className="h-4 w-4" />, !editor.can().redo())}
          </>
        )}
      </div>
      {full && <p className="text-[11px] text-zinc-400">Font, size, line and gap apply to the whole email; the rest applies to the text you select.</p>}
      {linkOpen && (
        <div className="space-y-1 rounded-lg bg-zinc-50 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={linkInputRef}
              type="text"
              inputMode="url"
              value={linkValue}
              onChange={(e) => {
                setLinkValue(e.target.value)
                if (linkError) setLinkError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyLink()
                } else if (e.key === 'Escape') {
                  // Close just this box — the Esc must not also close the pop-up around it.
                  e.preventDefault()
                  e.stopPropagation()
                  closeLink()
                }
              }}
              placeholder="Paste or type a web address (https://…)"
              aria-label="Link address"
              className="min-w-[12rem] flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button type="button" onClick={applyLink} className="rounded-md bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600">
              Apply
            </button>
            {editor.isActive('link') && (
              <button type="button" onClick={removeLink} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200">
                Remove link
              </button>
            )}
            <button type="button" onClick={closeLink} aria-label="Close link box" className="rounded-md p-1 text-zinc-500 hover:bg-zinc-200">
              <X className="h-4 w-4" />
            </button>
          </div>
          {linkError && (
            <p role="alert" className="text-xs text-red-600">
              {linkError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
