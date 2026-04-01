'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Bot, X, Send, Loader2, Trash2, Mic, Square, Sparkles, Paperclip, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface AttachedFile {
  name: string
  size: number
  type: string
  base64: string
  preview?: string  // data URL for images
}

type Provider = 'auto' | 'claude' | 'openai'

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/csv', 'text/plain']
const MAX_FILE_SIZE = 10 * 1024 * 1024  // 10MB

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AiAgentPanel({ enabled = true }: { enabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [provider, setProvider] = useState<Provider>('auto')
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Voice input
  const handleTranscript = useCallback((text: string) => {
    setInput(prev => (prev ? prev + ' ' + text : text).trim())
    inputRef.current?.focus()
  }, [])

  const {
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    isSupported: micSupported,
  } = useVoiceInput({ language: 'en-US', onTranscript: handleTranscript })

  // File selection + validation
  const handleFileSelect = useCallback((file: File) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error('Unsupported file type. Allowed: PNG, JPG, WEBP, PDF, CSV, TXT')
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.error('File too large (max 10MB)')
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      const base64 = dataUrl.split(',')[1]
      setAttachedFile({
        name: file.name,
        size: file.size,
        type: file.type,
        base64,
        preview: file.type.startsWith('image/') ? dataUrl : undefined,
      })
    }
    reader.readAsDataURL(file)
  }, [])

  // Drag & drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }, [handleFileSelect])

  // Listen for open event from sidebar (with optional email context)
  useEffect(() => {
    function handleOpen(e: Event) {
      setOpen(true)
      const detail = (e as CustomEvent)?.detail
      if (detail?.emailContext) {
        const ctx = detail.emailContext
        const autoPrompt = `I'm looking at this email. Analyze it and suggest a reply + any CRM actions I should take.\n\n**From:** ${ctx.name}\n**Subject:** ${ctx.subject}\n**Preview:** ${ctx.preview}\n**Thread ID:** ${ctx.threadId}`
        setTimeout(() => {
          setInput('')
          const userMsg: Message = { role: 'user', content: autoPrompt }
          setMessages(prev => [...prev, userMsg])
          sendMessage([...messages, userMsg])
        }, 200)
      }
    }
    document.addEventListener('open-ai-agent', handleOpen)
    return () => document.removeEventListener('open-ai-agent', handleOpen)
  }, [messages]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus input when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, loading])

  // Auto-grow textarea
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.max(44, Math.min(el.scrollHeight, 120)) + 'px'
  }, [input])

  const sendMessage = async (msgs: Message[], attachment?: AttachedFile | null) => {
    setLoading(true)
    try {
      const res = await fetch('/api/ai-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: msgs.map(m => ({ role: m.role, content: m.content })),
          provider: provider !== 'auto' ? provider : undefined,
          attachment: attachment
            ? { name: attachment.name, type: attachment.type, base64: attachment.base64 }
            : undefined,
        }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(errData.error || `Request failed (${res.status})`)
      }

      const data = await res.json()
      const providerTag = data.provider === 'claude' ? '' : data.provider === 'openai' ? ' _(GPT-4o fallback)_' : ''
      const toolInfo = data.tools_used?.length ? `\n\n_🔧 Used: ${Array.from(new Set(data.tools_used) as Set<string>).join(', ')}_` : ''
      setMessages(prev => [...prev, { role: 'assistant', content: (data.content || 'No response.') + providerTag + toolInfo }])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${errMsg}` }])
    } finally {
      setLoading(false)
    }
  }

  const handleSend = async () => {
    const text = input.trim()
    if ((!text && !attachedFile) || loading) return
    if (isRecording) stopRecording()

    // Build display content (what shows in chat history)
    const displayContent = [
      text,
      attachedFile ? `📎 ${attachedFile.name}` : '',
    ].filter(Boolean).join('\n\n')

    const userMessage: Message = { role: 'user', content: displayContent }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')
    const fileToSend = attachedFile
    setAttachedFile(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    await sendMessage(newMessages, fileToSend)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const clearChat = () => {
    setMessages([])
    setAttachedFile(null)
  }

  if (!open) return null

  if (!enabled) {
    return (
      <>
        <div className="fixed inset-0 z-[55] bg-black/30 lg:hidden" onClick={() => setOpen(false)} />
        <div className="fixed right-0 top-0 bottom-0 z-[55] w-full sm:w-[420px] bg-white border-l shadow-2xl flex flex-col items-center justify-center p-8">
          <Bot className="h-12 w-12 text-zinc-300 mb-4" />
          <h3 className="text-lg font-semibold text-zinc-700 mb-2">AI Agent Not Enabled</h3>
          <p className="text-sm text-zinc-500 text-center">Ask your admin to enable the AI Agent for team members in Team Management settings.</p>
          <button onClick={() => setOpen(false)} className="mt-6 px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm">Close</button>
        </div>
      </>
    )
  }

  return (
    <>
      {/* Backdrop on mobile */}
      <div
        className="fixed inset-0 z-[55] bg-black/30 lg:hidden"
        onClick={() => setOpen(false)}
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 bottom-0 z-[55] w-full sm:w-[420px] bg-white border-l shadow-2xl flex flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag & drop overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-violet-400 bg-violet-50/90 pointer-events-none">
            <div className="text-center">
              <Paperclip className="h-10 w-10 text-violet-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-violet-600">Drop file here</p>
              <p className="text-xs text-violet-400 mt-1">PNG, JPG, WEBP, PDF, CSV, TXT — max 10MB</p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-gradient-to-r from-violet-50 to-blue-50">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-violet-100">
              <Bot className="h-5 w-5 text-violet-600" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">AI Agent</h2>
              <p className="text-[10px] text-zinc-500">Search, analyze, create tasks</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Provider selector */}
            <select
              value={provider}
              onChange={e => setProvider(e.target.value as Provider)}
              className="text-[11px] bg-white border border-zinc-200 rounded-md px-1.5 py-1 text-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-400 cursor-pointer"
              title="Choose AI provider"
            >
              <option value="auto">Auto (Claude → GPT)</option>
              <option value="claude">Claude only</option>
              <option value="openai">GPT-4o only</option>
            </select>
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                className="p-2 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                title="Clear chat"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => setOpen(false)}
              className="p-2 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="p-4 rounded-2xl bg-violet-50 mb-4">
                <Sparkles className="h-8 w-8 text-violet-500" />
              </div>
              <h3 className="text-base font-semibold text-zinc-900 mb-1">CRM AI Agent</h3>
              <p className="text-sm text-zinc-500 mb-6">
                Ask me anything about your clients, services, payments, or tasks.
              </p>
              <div className="space-y-2 w-full max-w-xs">
                {[
                  'Show me all overdue payments',
                  'What services are in progress?',
                  'Find client Marco Rossi',
                  'Create a task to follow up with...',
                  'Dashboard overview',
                ].map(suggestion => (
                  <button
                    key={suggestion}
                    onClick={() => {
                      setInput(suggestion)
                      inputRef.current?.focus()
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-zinc-600 bg-zinc-50 rounded-lg hover:bg-violet-50 hover:text-violet-700 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn(
                'flex',
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              )}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm',
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-md'
                    : 'bg-zinc-100 text-zinc-900 rounded-bl-md'
                )}
              >
                {msg.role === 'assistant' ? (
                  <div className="prose prose-sm prose-zinc max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_a]:text-blue-600 [&_a]:underline [&_code]:bg-zinc-200 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-zinc-800 [&_pre]:text-zinc-100 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_table]:text-xs [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_img]:rounded-lg [&_img]:max-w-full [&_img]:my-2 [&_img]:border [&_img]:shadow-sm">
                    <ReactMarkdown
                      components={{
                        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
                        img: (props) => <img {...props} loading="lazy" style={{ maxHeight: 400 }} />,
                      }}
                    >{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-zinc-100 rounded-2xl rounded-bl-md px-4 py-3 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
                <span className="text-sm text-zinc-500">Thinking...</span>
              </div>
            </div>
          )}
        </div>

        {/* Recording indicator */}
        {(isRecording || isTranscribing) && (
          <div className="px-4 py-2 bg-red-50 border-t border-red-100 flex items-center gap-2">
            {isRecording && (
              <>
                <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
                <span className="text-xs text-red-600 font-medium">Recording... tap mic to stop</span>
              </>
            )}
            {isTranscribing && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                <span className="text-xs text-blue-600 font-medium">Transcribing...</span>
              </>
            )}
          </div>
        )}

        {/* File preview strip */}
        {attachedFile && (
          <div className="px-3 py-2 border-t bg-violet-50 flex items-center gap-2">
            {attachedFile.preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={attachedFile.preview}
                alt={attachedFile.name}
                className="h-10 w-10 rounded object-cover border border-violet-200 shrink-0"
              />
            ) : (
              <div className="h-10 w-10 rounded bg-violet-100 border border-violet-200 flex items-center justify-center shrink-0">
                <FileText className="h-5 w-5 text-violet-500" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-zinc-800 truncate">{attachedFile.name}</p>
              <p className="text-[10px] text-zinc-400">{formatFileSize(attachedFile.size)}</p>
            </div>
            <button
              onClick={() => setAttachedFile(null)}
              className="p-1 rounded-full text-zinc-400 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
              title="Remove attachment"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Input */}
        <div className="border-t p-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={isRecording ? 'Recording...' : 'Ask anything about your CRM...'}
              className={cn(
                'flex-1 min-w-0 px-4 py-3 text-sm border rounded-xl bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:bg-white resize-none overflow-y-auto transition-colors',
                isRecording && 'ring-2 ring-red-300 bg-red-50/50'
              )}
            />
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.pdf,.csv,.txt"
              onChange={e => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
              className="hidden"
            />
            {/* Attach */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              className={cn(
                'p-3 rounded-xl transition-colors shrink-0',
                attachedFile
                  ? 'bg-violet-100 text-violet-600'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-violet-100 hover:text-violet-600'
              )}
              title="Attach file (PNG, JPG, WEBP, PDF, CSV, TXT)"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            {/* Mic */}
            {micSupported && (
              isRecording ? (
                <button
                  onClick={stopRecording}
                  className="p-3 rounded-xl bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30 animate-pulse transition-all shrink-0"
                >
                  <Square className="h-5 w-5 fill-current" />
                </button>
              ) : isTranscribing ? (
                <button disabled className="p-3 rounded-xl bg-blue-100 text-blue-500 shrink-0">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </button>
              ) : (
                <button
                  onClick={startRecording}
                  className="p-3 rounded-xl bg-zinc-100 text-zinc-600 hover:bg-violet-100 hover:text-violet-600 transition-colors shrink-0"
                  title="Voice input"
                >
                  <Mic className="h-5 w-5" />
                </button>
              )
            )}
            {/* Send */}
            <button
              onClick={handleSend}
              disabled={(!input.trim() && !attachedFile) || loading}
              className="p-3 rounded-xl bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
