import React, { useCallback, useEffect, useState } from 'react';

const API = (window.__CONFIG__ && window.__CONFIG__.API_BASE_URL) || '/api';

async function call(path, options) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`${options?.method || 'GET'} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function StatusDot({ label, state }) {
  const cls = state === undefined ? 'dot' : state.ok ? 'dot ok' : 'dot bad';
  return <span className="pill"><i className={cls} /> {label}</span>;
}

export default function App() {
  const [todos, setTodos] = useState([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState({});

  const load = useCallback(async () => {
    try {
      setTodos(await call('/todos'));
      setStatus(await call('/platform/status'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // picks up worker-set "processed" flags
    return () => clearInterval(t);
  }, [load]);

  async function add(e) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await call('/todos', { method: 'POST', body: JSON.stringify({ title }) });
      setTitle('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const toggle = (t) => call(`/todos/${t.id}`, { method: 'PATCH', body: JSON.stringify({ done: !t.done }) }).then(load).catch((e) => setError(e.message));
  const remove = (t) => call(`/todos/${t.id}`, { method: 'DELETE' }).then(load).catch((e) => setError(e.message));

  return (
    <main>
      <h1>Platform Todos</h1>
      <p className="sub">React → Ingress → Node API → PostgreSQL (+ Redis queue, search)</p>

      <div className="status">
        <StatusDot label="DB write" state={status.dbWrite} />
        <StatusDot label="DB read" state={status.dbRead} />
        <StatusDot label="Redis" state={status.redis} />
        <StatusDot label="Search" state={status.search} />
      </div>

      <form onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" maxLength={200} />
        <button type="submit">Add</button>
      </form>

      {error && <p className="error">API error: {error}</p>}

      <ul>
        {todos.map((t) => (
          <li key={t.id}>
            <label className={t.done ? 'done' : ''}>
              <input type="checkbox" checked={t.done} onChange={() => toggle(t)} /> {t.title}
            </label>
            {t.processed_at && <small title="Processed by the queue worker">worker ✓</small>}
            <button className="link" onClick={() => remove(t)} aria-label="delete">✕</button>
          </li>
        ))}
        {!todos.length && !error && <li className="empty">Nothing yet - add your first todo.</li>}
      </ul>
    </main>
  );
}
