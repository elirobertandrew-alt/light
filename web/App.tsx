import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'

type Tab = 'Overview' | 'Models' | 'Routing' | 'Providers' | 'Limits' | 'Logs' | 'API Keys'
type AnyRecord = Record<string, any>
const tabs: Tab[] = ['Overview', 'Models', 'Routing', 'Providers', 'Limits', 'Logs', 'API Keys']
const endpoints: Record<Tab, string> = {
  Overview: '/admin/logs', Models: '/admin/models', Logs: '/admin/logs', Providers: '/admin/providers',
  Routing: '/admin/routes', Limits: '/admin/limits', 'API Keys': '/admin/keys',
}
const overviewEndpoints = ['logs', 'providers', 'routes', 'limits', 'keys'] as const
const staticMode = import.meta.env.VITE_STATIC_MODE === 'true'
const localConfigKey = 'light.config'

function localRequest(url: string, init?: RequestInit) {
  const match = /^\/admin\/(providers|models|routes|limits|keys|logs)(?:\/([^/]+))?$/.exec(url)
  if (!match) throw new Error('Unsupported local operation')
  const [, collection, id] = match
  const config = JSON.parse(localStorage.getItem(localConfigKey) ?? '{}') as Record<string, AnyRecord[]>
  const rows = config[collection] ?? []
  const method = init?.method ?? 'GET'
  if (method === 'GET') return id ? rows.find(row => row.id === id) ?? null : rows
  if (method === 'DELETE') config[collection] = rows.filter(row => row.id !== id)
  else {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (method === 'POST') {
      const created = { ...body, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
      config[collection] = [...rows, created]
      localStorage.setItem(localConfigKey, JSON.stringify(config))
      return created
    }
    const updated = rows.map(row => row.id === id ? { ...row, ...body } : row)
    config[collection] = updated
  }
  localStorage.setItem(localConfigKey, JSON.stringify(config))
  return null
}

function list(value: any): AnyRecord[] {
  if (Array.isArray(value)) return value
  for (const key of ['items', 'data', 'logs', 'providers', 'routes', 'limits', 'keys']) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}
function label(value: any) { return String(value ?? '—').replaceAll('_', ' ') }
function statusClass(value: any) {
  const s = String(value ?? '').toLowerCase()
  return s.includes('error') || s.includes('fail') || s.includes('denied') ? 'bad' : s.includes('warn') || s.includes('pending') ? 'warn' : 'good'
}
function time(value: any) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.valueOf()) ? String(value) : d.toLocaleString()
}

export default function App() {
  const [tab, setTab] = useState<Tab>('Overview')
  const [token, setToken] = useState(() => staticMode ? 'browser-local' : sessionStorage.getItem('light.adminToken') ?? '')
  const [draft, setDraft] = useState(token)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<AnyRecord | null>(null)
  const [revealed, setRevealed] = useState('')

  const request = useCallback(async (url: string, init?: RequestInit) => {
    if (staticMode) return localRequest(url, init)
    const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}`, 'X-Admin-Token': token } : {}), ...init?.headers } })
    const text = await response.text()
    let body: any = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    if (!response.ok) {
      if (response.status === 404) return localRequest(url, init)
      throw new Error(body?.message || body?.error || `${response.status} ${response.statusText}`)
    }
    return body
  }, [token])

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true); setError(''); setSelected(null); setRevealed('')
    try {
      if (tab === 'Overview') {
        const values = await Promise.all(overviewEndpoints.map(name => request(`/admin/${name}`)))
        setData(Object.fromEntries(overviewEndpoints.map((name, index) => [name, values[index]])))
      } else setData(await request(endpoints[tab]))
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); setData(null) }
    finally { setLoading(false) }
  }, [request, tab, token])
  useEffect(() => { load() }, [load])

  function signIn(e: FormEvent) {
    e.preventDefault()
    const value = draft.trim()
    sessionStorage.setItem('light.adminToken', value); setToken(value)
  }
  function signOut() { sessionStorage.removeItem('light.adminToken'); setToken(''); setDraft(''); setData(null) }

  if (!token) return <main className="login-shell"><section className="login-card">
    <div className="brand-mark">L</div><p className="eyebrow">Light Control Plane</p><h1>Admin access</h1>
    <p className="muted">Enter your admin token. It stays in this browser tab and is cleared when the session ends.</p>
    <form onSubmit={signIn}><label>Admin token<input autoFocus type="password" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Paste token" /></label><button disabled={!draft.trim()}>Open dashboard</button></form>
  </section></main>

  return <div className="app-shell">
    <aside><div className="brand"><span className="brand-mark small">L</span><span><b>Light</b><small>Model control</small></span></div>
      <nav>{tabs.map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}><span>{icons[item]}</span>{item}</button>)}</nav>
      <div className="sidebar-foot"><span className="live-dot"/> {staticMode ? 'Browser local' : 'Connected'} {!staticMode && <button className="link" onClick={signOut}>Sign out</button>}</div>
    </aside>
    <main className="workspace"><header><div><p className="eyebrow">Operations</p><h1>{tab}</h1></div><button className="secondary" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</button></header>
      {error ? <div className="notice error"><b>Couldn’t load {tab.toLowerCase()}</b><span>{error}</span><button onClick={load}>Retry</button></div> : null}
      {loading && data === null ? <div className="loading-grid">{[1,2,3,4].map(x => <div key={x}/>)}</div> : <Panel tab={tab} data={data} request={request} reload={load} selected={selected} setSelected={setSelected} revealed={revealed} setRevealed={setRevealed}/>} 
    </main>
  </div>
}

function Panel({ tab, data, request, reload, selected, setSelected, revealed, setRevealed }: any) {
  if (tab === 'Overview') return <Overview data={data}/>
  const rows = list(data)
  if (tab === 'Models') return <Models rows={rows} request={request} reload={reload}/>
  if (tab === 'Logs') return <><Table rows={rows} columns={['createdAt','model','status','stream']} onRow={setSelected}/>{selected && <Detail title="Log detail" value={selected} close={() => setSelected(null)}/>}</>
  if (tab === 'Providers') return <Providers rows={rows} request={request} reload={reload}/>
  if (tab === 'Routing') return <Routing rows={rows} request={request} reload={reload}/>
  if (tab === 'Limits') return <Table rows={rows} columns={['alias','requestLimit','requestsUsed']}/>
  if (tab === 'API Keys') return <ApiKeys rows={rows} request={request} reload={reload} revealed={revealed} setRevealed={setRevealed}/>
  return null
}
function Overview({ data }: { data: any }) {
  const stats = useMemo(() => {
    if (!data) return []
    return overviewEndpoints.map(name => ({ name, value: list(data[name]).length }))
  }, [data])
  const recent = list(data?.logs).slice(0, 10)
  if (!data) return <Empty title="No overview data" text="Metrics will appear when Light begins processing traffic."/>
  return <><div className="stat-grid">{stats.length ? stats.map(s => <article className="stat" key={s.name}><span>{label(s.name)}</span><strong>{String(s.value)}</strong></article>) : <article className="stat wide"><span>System</span><strong>Online</strong><small>Admin API connected</small></article>}</div>
    <section className="card"><div className="card-title"><div><h2>Recent activity</h2><p>Latest gateway requests</p></div></div><Table rows={recent} columns={['createdAt','model','status','stream']}/></section></>
}
function Models({ rows, request, reload }: { rows: AnyRecord[], request: (url: string, init?: RequestInit) => Promise<any>, reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  async function save(e: FormEvent) {
    e.preventDefault()
    await request('/admin/models', { method: 'POST', body: JSON.stringify({ name, providerId: providerId || undefined, modelId: modelId || undefined, enabled: false }) })
    setName(''); setProviderId(''); setModelId(''); setOpen(false); await reload()
  }
  async function remove(id: string) { await request(`/admin/models/${id}`, { method: 'DELETE' }); await reload() }
  return <>
    <section className="card create-key"><div><h2>Model catalog</h2><p>Prepare model placeholders now; connect adapters later.</p></div><button onClick={() => setOpen(!open)}>{open ? 'Cancel' : 'Add model'}</button></section>
    <div className="notice"><b>Disconnected by design</b><span>No model credentials or inference connections are configured yet.</span></div>
    {open && <section className="card provider-form"><form onSubmit={save}>
      <label>Display name<input aria-label="Model name" value={name} onChange={e => setName(e.target.value)} required /></label>
      <label>Provider placeholder ID<input aria-label="Model provider" value={providerId} onChange={e => setProviderId(e.target.value)} /></label>
      <label>Future model ID<input aria-label="Future model ID" value={modelId} onChange={e => setModelId(e.target.value)} /></label>
      <button disabled={!name.trim()}>Create model</button>
    </form></section>}
    {!rows.length ? <Empty title="No model placeholders" text="Add the models you want to place in a fallback order."/> : <div className="provider-grid">{rows.map((model, index) => <article className="provider" key={model.id ?? index}><div className="provider-top"><span className="provider-icon">AI</span><span className="badge neutral">Disconnected</span></div><h2>{model.name}</h2><p>{model.modelId || 'Model ID not set'}</p><small className="metadata-note">Provider: {model.providerId || 'Not assigned'}</small>{model.id && <button className="secondary" onClick={() => remove(String(model.id))}>Delete</button>}</article>)}</div>}
  </>
}
function Routing({ rows, request, reload }: { rows: AnyRecord[], request: (url: string, init?: RequestInit) => Promise<any>, reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [alias, setAlias] = useState('assistant')
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const nextPriority = rows.length ? Math.max(...rows.map(row => Number(row.priority ?? 0))) + 1 : 1
  async function save(e: FormEvent) {
    e.preventDefault()
    await request('/admin/routes', { method: 'POST', body: JSON.stringify({ alias, providerId, modelId, priority: nextPriority, enabled: true }) })
    setProviderId(''); setModelId(''); setOpen(false); await reload()
  }
  async function move(row: AnyRecord, delta: number) {
    await request(`/admin/routes/${row.id}`, { method: 'PATCH', body: JSON.stringify({ ...row, priority: Math.max(1, Number(row.priority ?? 1) + delta) }) }); await reload()
  }
  async function remove(id: string) { await request(`/admin/routes/${id}`, { method: 'DELETE' }); await reload() }
  return <>
    <section className="card create-key"><div><h2>Automatic fallback order</h2><p>Lower numbers run first. When a connected model exhausts its usage, Light will try the next entry.</p></div><button onClick={() => setOpen(!open)}>{open ? 'Cancel' : 'Add fallback'}</button></section>
    <div className="notice"><b>Ready, not connected</b><span>This order is saved as metadata; no models are contacted in this release.</span></div>
    {open && <section className="card provider-form"><form onSubmit={save}>
      <label>Alias<input aria-label="Route alias" value={alias} onChange={e => setAlias(e.target.value)} required /></label>
      <label>Provider placeholder ID<input aria-label="Route provider" value={providerId} onChange={e => setProviderId(e.target.value)} required /></label>
      <label>Model placeholder ID<input aria-label="Route model" value={modelId} onChange={e => setModelId(e.target.value)} required /></label>
      <button disabled={!alias.trim() || !providerId.trim() || !modelId.trim()}>Add as priority {nextPriority}</button>
    </form></section>}
    {!rows.length ? <Empty title="No fallback order" text="Add model placeholders in the order Light should try them."/> : <div className="fallback-list">{rows.map((row, index) => <article className="card fallback-row" key={row.id ?? index}><strong className="priority">{row.priority}</strong><div><h2>{row.alias}</h2><p>{row.modelId || 'Unassigned model'} · {row.providerId || 'Unassigned provider'}</p></div><span className="badge neutral">Disconnected</span><div className="fallback-actions"><button className="secondary" aria-label={`Move ${row.alias} up`} disabled={Number(row.priority) <= 1} onClick={() => move(row, -1)}>↑</button><button className="secondary" aria-label={`Move ${row.alias} down`} onClick={() => move(row, 1)}>↓</button><button className="secondary" onClick={() => remove(String(row.id))}>Delete</button></div></article>)}</div>}
  </>
}
function Providers({ rows, request, reload }: { rows: AnyRecord[], request: (url: string, init?: RequestInit) => Promise<any>, reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState('openai-compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [description, setDescription] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)

  function reset() { setName(''); setKind('openai-compatible'); setBaseUrl(''); setDescription(''); setEnabled(false); setEditingId(''); setOpen(false) }
  function edit(provider: AnyRecord) {
    setName(provider.name ?? ''); setKind(provider.kind ?? provider.type ?? 'openai-compatible')
    setBaseUrl(provider.baseUrl ?? provider.base_url ?? ''); setDescription(provider.description ?? '')
    setEnabled(provider.enabled ?? false); setEditingId(String(provider.id)); setOpen(true)
  }
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true)
    try {
      await request(editingId ? `/admin/providers/${editingId}` : '/admin/providers', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify({ name, kind, baseUrl: baseUrl || undefined, description: description || undefined, enabled }) })
      reset(); await reload()
    } finally { setBusy(false) }
  }
  async function remove(id: string) { await request(`/admin/providers/${id}`, { method: 'DELETE' }); await reload() }

  return <>
    <section className="card create-key"><div><h2>Provider metadata</h2><p>Describe future adapters without storing credentials or making network calls.</p></div><button onClick={() => open ? reset() : setOpen(true)}>{open ? 'Cancel' : 'Add provider'}</button></section>
    {open && <section className="card provider-form"><form onSubmit={save}>
      <label>Name<input aria-label="Provider name" value={name} onChange={e => setName(e.target.value)} required /></label>
      <label>Type<input aria-label="Provider type" value={kind} onChange={e => setKind(e.target.value)} required /></label>
      <label>Base URL (metadata only)<input aria-label="Base URL" type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://example.invalid/v1" /></label>
      <label>Description<input aria-label="Description" value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label><input aria-label="Provider enabled" type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enabled</label>
      <button disabled={busy || !name.trim()}>{busy ? 'Saving…' : editingId ? 'Save provider' : 'Create provider'}</button>
    </form></section>}
    {!rows.length ? <Empty title="No providers configured" text="Add metadata for a future provider adapter."/> : <div className="provider-grid">{rows.map((p, i) => <article className="provider" key={p.id ?? i}><div className="provider-top"><span className="provider-icon">{String(p.name ?? 'P').slice(0,2).toUpperCase()}</span><span className={`badge ${p.enabled ? 'good' : 'neutral'}`}>{p.enabled ? 'Enabled' : 'Disabled'}</span></div><h2>{p.name ?? 'Provider'}</h2><p>{p.baseUrl ?? p.description ?? 'No endpoint metadata'}</p><small className="metadata-note">Metadata only · runtime access is managed server-side</small>{p.id && <div><button className="secondary" onClick={() => edit(p)}>Edit</button> <button className="secondary" onClick={() => remove(String(p.id))}>Delete</button></div>}</article>)}</div>}
  </>
}
function ApiKeys({ rows, request, reload, revealed, setRevealed }: any) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  async function create(e: FormEvent) { e.preventDefault(); setBusy(true); try { const out = await request('/admin/keys', { method: 'POST', body: JSON.stringify({ name }) }); setRevealed(out?.key ?? ''); setName(''); await reload() } finally { setBusy(false) } }
  return <><section className="card create-key"><div><h2>API keys</h2><p>Create scoped access for clients. New secrets are shown once.</p></div><form onSubmit={create}><input value={name} onChange={e => setName(e.target.value)} placeholder="Key name"/><button disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create key'}</button></form></section>
    {revealed && <div className="reveal"><div><b>Copy this key now</b><span>It won’t be shown again.</span></div><code>{revealed}</code><button onClick={() => navigator.clipboard.writeText(revealed)}>Copy</button><button className="icon-btn" onClick={() => setRevealed('')}>×</button></div>}
    <Table rows={rows.map((row: AnyRecord) => ({ ...row, status: row.revoked ? 'Revoked' : 'Active' }))} columns={['name','prefix','createdAt','status']}/></>
}
function Table({ rows, columns, onRow }: { rows: AnyRecord[], columns: string[], onRow?: (x: AnyRecord) => void }) {
  if (!rows?.length) return <Empty title="Nothing here yet" text="Records will show up here as they become available." compact/>
  return <div className="table-wrap"><table><thead><tr>{columns.map(c => <th key={c}>{label(c)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={row.id ?? i} onClick={() => onRow?.(row)} className={onRow ? 'clickable' : ''}>{columns.map(c => <td key={c}>{c === 'status' ? <span className={`badge ${statusClass(row[c])}`}>{label(row[c])}</span> : c.toLowerCase().includes('time') || c.toLowerCase().endsWith('at') ? time(row[c]) : typeof row[c] === 'boolean' ? (row[c] ? 'Yes' : 'No') : label(row[c])}</td>)}</tr>)}</tbody></table></div>
}
function Detail({ title, value, close }: any) { return <div className="drawer-backdrop" onClick={close}><aside className="drawer" onClick={e => e.stopPropagation()}><div className="drawer-title"><div><p className="eyebrow">Request inspection</p><h2>{title}</h2></div><button className="icon-btn" onClick={close}>×</button></div><div className="detail-list">{Object.entries(value).map(([k,v]) => <div key={k}><dt>{label(k)}</dt><dd>{typeof v === 'object' ? <pre>{JSON.stringify(v,null,2)}</pre> : String(v ?? '—')}</dd></div>)}</div></aside></div> }
function Empty({ title, text, compact }: { title: string, text: string, compact?: boolean }) { return <div className={`empty ${compact ? 'compact' : ''}`}><span>◇</span><h2>{title}</h2><p>{text}</p></div> }
const icons: Record<Tab,string> = { Overview:'◫', Models:'◎', Routing:'⑂', Providers:'⬡', Limits:'◒', Logs:'≡', 'API Keys':'⌁' }
