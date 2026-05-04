import React, { useState, useEffect, useRef } from 'react';
import {
  Send, Lock, Inbox, Check, X, Eye, EyeOff, Reply, Trash2,
  ArrowLeft, Search, ImagePlus, Paperclip
} from 'lucide-react';
import {
  addQuestion as fbAdd,
  subscribeQuestions,
  updateQuestion as fbUpdate,
  deleteQuestion as fbDelete,
} from './firebase';

// Admin password — change this. Note: client-side only, fine for casual use.
// For real security, use Firebase Auth instead.
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || 'changeme';

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export default function App() {
  const [view, setView] = useState('public');
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let unsub;
    try {
      unsub = subscribeQuestions((items) => {
        setQuestions(items);
        setLoading(false);
      });
    } catch (e) {
      setError('FIREBASE_NOT_CONFIGURED');
      setLoading(false);
    }
    return () => unsub && unsub();
  }, []);

  const handleAdd = async (q) => {
    await fbAdd(q);
  };
  const handleUpdate = async (id, patch) => {
    await fbUpdate(id, patch);
  };
  const handleDelete = async (id) => {
    await fbDelete(id);
  };

  return (
    <div style={styles.app}>
      <CRTBackground />
      <div style={styles.container}>
        <Header view={view} setView={setView} />
        {error ? (
          <ConfigError />
        ) : loading ? (
          <div style={styles.loading}>CONNECTING<Dots /></div>
        ) : view === 'public' ? (
          <PublicView onSubmit={handleAdd} />
        ) : view === 'admin-login' ? (
          <AdminLogin onSuccess={() => setView('admin')} onCancel={() => setView('public')} />
        ) : (
          <AdminView
            questions={questions}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        )}
        <Footer />
      </div>
    </div>
  );
}

function ConfigError() {
  return (
    <main style={styles.main}>
      <div style={{ ...styles.successCard, borderColor: '#ff336640', background: '#ff336608' }}>
        <div style={{ ...styles.successIcon, borderColor: '#ff3366', color: '#ff3366', boxShadow: '0 0 20px #ff336630' }}>
          <X size={32} strokeWidth={1.5} />
        </div>
        <div style={{ ...styles.successTitle, color: '#ff3366' }}>FIREBASE_NOT_CONFIGURED</div>
        <div style={styles.successSub}>
          Set your Firebase env vars and rebuild. See README.md for instructions.
        </div>
      </div>
    </main>
  );
}

function Header({ view, setView }) {
  return (
    <header style={styles.header}>
      <div style={styles.headerLeft}>
        <div style={styles.logo}>
          <span style={styles.logoBracket}>[</span>
          <span style={styles.logoText}>SM</span>
          <span style={styles.logoBracket}>]</span>
          <span style={styles.logoSlash}>//</span>
          <span style={styles.logoSub}>SPACE_MONKEY</span>
        </div>
        <div style={styles.statusLine}>
          <span style={styles.statusDot} />
          <span>SECURE_CHANNEL_OPEN</span>
        </div>
      </div>
      <nav style={styles.nav}>
        {view !== 'public' && (
          <button style={styles.navBtn} onClick={() => setView('public')}>
            <ArrowLeft size={12} />
            <span>PUBLIC</span>
          </button>
        )}
        {view === 'public' && (
          <button style={styles.navBtn} onClick={() => setView('admin-login')}>
            <Lock size={12} />
            <span>ADMIN</span>
          </button>
        )}
      </nav>
    </header>
  );
}

function PublicView({ onSubmit }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [question, setQuestion] = useState('');
  const [images, setImages] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const MAX_IMAGES = 4;
  const MAX_SIZE = 1.5 * 1024 * 1024; // 1.5MB per image (Firestore doc 1MB total ceiling)

  const handleFiles = async (files) => {
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (list.length === 0) return;
    if (images.length + list.length > MAX_IMAGES) {
      setError(`MAX ${MAX_IMAGES} IMAGES`);
      return;
    }
    const newImages = [];
    for (const file of list) {
      if (file.size > MAX_SIZE) {
        setError(`${file.name.toUpperCase()} TOO LARGE // MAX 1.5MB`);
        continue;
      }
      // Resize/compress to keep under Firestore doc limit
      const dataUrl = await compressImage(file);
      newImages.push({
        id: uid(),
        dataUrl,
        name: file.name,
        size: file.size,
      });
    }
    setImages([...images, ...newImages]);
    if (newImages.length > 0 && error) setError('');
  };

  const removeImage = (id) => setImages(images.filter(img => img.id !== id));

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  };

  const handleSubmit = async () => {
    if (!question.trim()) { setError('QUESTION REQUIRED'); return; }
    if (question.trim().length < 5) { setError('TOO SHORT // MIN 5 CHARS'); return; }
    setError('');
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim() || 'ANONYMOUS',
        email: email.trim(),
        question: question.trim(),
        images,
      });
      setSubmitted(true);
      setTimeout(() => {
        setSubmitted(false);
        setName(''); setEmail(''); setQuestion(''); setImages([]);
      }, 3000);
    } catch (e) {
      setError('TRANSMISSION_FAILED // TRY_AGAIN');
    }
    setSubmitting(false);
  };

  if (submitted) {
    return (
      <main style={styles.main}>
        <div style={styles.successCard}>
          <div style={styles.successIcon}>
            <Check size={32} strokeWidth={1.5} />
          </div>
          <div style={styles.successTitle}>TRANSMISSION_RECEIVED</div>
          <div style={styles.successSub}>Your question has been logged. Reply incoming.</div>
          <div style={styles.scanline} />
        </div>
      </main>
    );
  }

  return (
    <main style={styles.main}>
      <div style={styles.intro}>
        <div style={styles.introLabel}>// DROP_BOX</div>
        <h1 style={styles.h1}>Ask me anything.</h1>
        <p style={styles.lede}>
          Private channel. Your question lands directly in my inbox. I read everything and reply when I can.
        </p>
      </div>

      <div style={styles.form}>
        <Field label="NAME // OPTIONAL">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Anonymous is fine" style={styles.input} maxLength={60} />
        </Field>

        <Field label="EMAIL // OPTIONAL">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="So I can reply directly if needed" style={styles.input} maxLength={120} />
        </Field>

        <Field label="QUESTION // REQUIRED">
          <textarea
            value={question}
            onChange={(e) => { setQuestion(e.target.value); if (error) setError(''); }}
            placeholder="Whatever's on your mind. Trading, GEX, the build, the process — anything."
            style={styles.textarea} rows={6} maxLength={2000}
          />
          <div style={styles.counter}>{question.length} / 2000</div>
        </Field>

        <Field label={`ATTACHMENTS // OPTIONAL · ${images.length}/${MAX_IMAGES}`}>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              ...styles.dropZone,
              borderColor: dragOver ? '#00ff88' : '#2a2f35',
              background: dragOver ? '#00ff8808' : '#12161a',
            }}
          >
            <input ref={fileInputRef} type="file" accept="image/*" multiple
              onChange={(e) => handleFiles(e.target.files)} style={{ display: 'none' }} />
            <ImagePlus size={18} strokeWidth={1.5} style={{ color: dragOver ? '#00ff88' : '#5a6066' }} />
            <div style={styles.dropText}>{dragOver ? 'DROP_IMAGES' : 'CLICK_OR_DRAG_IMAGES'}</div>
            <div style={styles.dropHint}>PNG · JPG · WEBP · MAX 1.5MB EACH</div>
          </div>

          {images.length > 0 && (
            <div style={styles.imageGrid}>
              {images.map(img => (
                <div key={img.id} style={styles.imageThumb}>
                  <img src={img.dataUrl} alt={img.name} style={styles.imageThumbImg} />
                  <button onClick={(e) => { e.stopPropagation(); removeImage(img.id); }}
                    style={styles.imageRemove} type="button">
                    <X size={12} />
                  </button>
                  <div style={styles.imageThumbName}>{img.name}</div>
                </div>
              ))}
            </div>
          )}
        </Field>

        {error && <div style={styles.errorBox}>! {error}</div>}

        <button onClick={handleSubmit} disabled={submitting}
          style={{ ...styles.submitBtn, opacity: submitting ? 0.5 : 1 }}>
          <span>{submitting ? 'TRANSMITTING' : 'TRANSMIT'}</span>
          {submitting ? <Dots /> : <Send size={14} strokeWidth={2} />}
        </button>
      </div>
    </main>
  );
}

// Compress images client-side to keep Firestore docs under 1MB
async function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1600;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function AdminLogin({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = () => {
    if (password === ADMIN_PASSWORD) onSuccess();
    else { setError('ACCESS_DENIED'); setPassword(''); }
  };

  return (
    <main style={styles.main}>
      <div style={styles.loginCard}>
        <div style={styles.loginIcon}><Lock size={20} strokeWidth={1.5} /></div>
        <div style={styles.introLabel}>// AUTHENTICATE</div>
        <h2 style={{ ...styles.h1, fontSize: 24 }}>Admin access</h2>
        <div style={{ height: 24 }} />
        <Field label="PASSWORD">
          <div style={{ position: 'relative' }}>
            <input ref={inputRef} type={show ? 'text' : 'password'} value={password}
              onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder="••••••••" style={{ ...styles.input, paddingRight: 40 }} />
            <button onClick={() => setShow(!show)} style={styles.eyeBtn} type="button">
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>
        {error && <div style={styles.errorBox}>! {error}</div>}
        <button onClick={handleSubmit} style={styles.submitBtn}>
          <span>UNLOCK</span>
          <Lock size={14} strokeWidth={2} />
        </button>
      </div>
    </main>
  );
}

function AdminView({ questions, onUpdate, onDelete }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const filtered = questions.filter(q => {
    if (filter === 'new' && q.status !== 'new') return false;
    if (filter === 'replied' && q.status !== 'replied') return false;
    if (search) {
      const s = search.toLowerCase();
      return q.question.toLowerCase().includes(s) ||
             (q.name || '').toLowerCase().includes(s) ||
             (q.email || '').toLowerCase().includes(s);
    }
    return true;
  });

  const selected = questions.find(q => q.id === selectedId);
  const newCount = questions.filter(q => q.status === 'new').length;
  const repliedCount = questions.filter(q => q.status === 'replied').length;

  if (selected) {
    return (
      <QuestionDetail question={selected} onBack={() => setSelectedId(null)}
        onUpdate={onUpdate}
        onDelete={(id) => { onDelete(id); setSelectedId(null); }} />
    );
  }

  return (
    <main style={styles.main}>
      <div style={styles.adminHeader}>
        <div>
          <div style={styles.introLabel}>// INBOX</div>
          <h2 style={{ ...styles.h1, fontSize: 28, margin: '4px 0 0' }}>
            {questions.length} {questions.length === 1 ? 'question' : 'questions'}
          </h2>
        </div>
        <div style={styles.filterRow}>
          <FilterPill active={filter === 'all'} onClick={() => setFilter('all')} count={questions.length}>ALL</FilterPill>
          <FilterPill active={filter === 'new'} onClick={() => setFilter('new')} count={newCount} accent="#00ff88">NEW</FilterPill>
          <FilterPill active={filter === 'replied'} onClick={() => setFilter('replied')} count={repliedCount} accent="#00d9ff">REPLIED</FilterPill>
        </div>
      </div>

      <div style={styles.searchRow}>
        <Search size={14} style={{ color: '#5a6066', flexShrink: 0 }} />
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="SEARCH_QUESTIONS" style={styles.searchInput} />
      </div>

      {filtered.length === 0 ? (
        <div style={styles.emptyState}>
          <Inbox size={32} strokeWidth={1} style={{ color: '#3a4046' }} />
          <div style={styles.emptyText}>{questions.length === 0 ? 'NO_QUESTIONS_YET' : 'NO_MATCHES'}</div>
          <div style={styles.emptyHint}>
            {questions.length === 0 ? 'Share the public link to start collecting questions.' : 'Try a different filter or search.'}
          </div>
        </div>
      ) : (
        <div style={styles.questionList}>
          {filtered.map(q => (
            <QuestionRow key={q.id} q={q} onClick={() => setSelectedId(q.id)} />
          ))}
        </div>
      )}
    </main>
  );
}

function FilterPill({ active, onClick, count, children, accent = '#e8e8e8' }) {
  return (
    <button onClick={onClick} style={{
      ...styles.filterPill,
      borderColor: active ? accent : '#2a2f35',
      color: active ? accent : '#888',
      background: active ? `${accent}10` : 'transparent',
    }}>
      <span>{children}</span>
      <span style={{ ...styles.filterCount, color: active ? accent : '#666' }}>{count}</span>
    </button>
  );
}

function QuestionRow({ q, onClick }) {
  const isNew = q.status === 'new';
  const accent = isNew ? '#00ff88' : '#00d9ff';
  const preview = q.question.length > 140 ? q.question.slice(0, 140) + '…' : q.question;

  return (
    <button onClick={onClick} style={styles.questionRow}>
      <div style={{ ...styles.statusBadge, color: accent, borderColor: accent }}>
        {isNew ? 'NEW' : 'REPLIED'}
      </div>
      <div style={styles.questionContent}>
        <div style={styles.questionMeta}>
          <span style={styles.questionName}>{q.name}</span>
          {q.email && <span style={styles.questionEmail}>{q.email}</span>}
          {q.images && q.images.length > 0 && (
            <span style={styles.questionAttach}>
              <Paperclip size={10} />{q.images.length}
            </span>
          )}
          <span style={styles.questionTime}>{fmtTime(q.createdAt)}</span>
        </div>
        <div style={styles.questionPreview}>{preview}</div>
      </div>
    </button>
  );
}

function QuestionDetail({ question, onBack, onUpdate, onDelete }) {
  const [reply, setReply] = useState(question.reply || '');
  const [editing, setEditing] = useState(!question.reply);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  const handleReply = async () => {
    if (!reply.trim()) return;
    setSaving(true);
    await onUpdate(question.id, { reply: reply.trim(), status: 'replied' });
    setSaving(false);
    setEditing(false);
  };

  const handleMarkUnread = async () => {
    await onUpdate(question.id, { status: 'new' });
  };

  return (
    <main style={styles.main}>
      <button onClick={onBack} style={styles.backBtn}>
        <ArrowLeft size={12} /><span>BACK_TO_INBOX</span>
      </button>

      <div style={styles.detailCard}>
        <div style={styles.detailMeta}>
          <div>
            <div style={styles.detailName}>{question.name}</div>
            {question.email && <div style={styles.detailEmail}>{question.email}</div>}
          </div>
          <div style={styles.detailTime}>{fmtTime(question.createdAt)}</div>
        </div>

        <div style={styles.detailDivider} />
        <div style={styles.detailLabel}>// QUESTION</div>
        <div style={styles.detailQuestion}>{question.question}</div>

        {question.images && question.images.length > 0 && (
          <>
            <div style={{ height: 16 }} />
            <div style={styles.detailLabel}>// ATTACHMENTS · {question.images.length}</div>
            <div style={styles.detailImageGrid}>
              {question.images.map(img => (
                <button key={img.id} onClick={() => setLightbox(img)}
                  style={styles.detailImageBtn} type="button">
                  <img src={img.dataUrl} alt={img.name} style={styles.detailImageImg} />
                </button>
              ))}
            </div>
          </>
        )}

        <div style={styles.detailDivider} />
        <div style={styles.detailLabel}>
          // REPLY {question.repliedAt && <span style={{ color: '#5a6066' }}>· sent {fmtTime(question.repliedAt)}</span>}
        </div>

        {editing ? (
          <>
            <textarea value={reply} onChange={(e) => setReply(e.target.value)}
              placeholder="Type your reply…" style={{ ...styles.textarea, minHeight: 160 }} autoFocus />
            <div style={styles.detailActions}>
              {question.reply && (
                <button onClick={() => { setReply(question.reply); setEditing(false); }} style={styles.secondaryBtn}>
                  CANCEL
                </button>
              )}
              <button onClick={handleReply} disabled={saving || !reply.trim()}
                style={{ ...styles.submitBtn, opacity: (saving || !reply.trim()) ? 0.5 : 1, marginTop: 0 }}>
                <span>{saving ? 'SAVING' : (question.reply ? 'UPDATE_REPLY' : 'SEND_REPLY')}</span>
                {saving ? <Dots /> : <Reply size={14} strokeWidth={2} />}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={styles.detailReply}>{question.reply}</div>
            <div style={styles.detailActions}>
              <button onClick={handleMarkUnread} style={styles.secondaryBtn}>MARK_UNREAD</button>
              <button onClick={() => setEditing(true)} style={styles.submitBtn}>
                <span>EDIT_REPLY</span><Reply size={14} strokeWidth={2} />
              </button>
            </div>
          </>
        )}

        <div style={styles.detailDivider} />
        <div style={styles.dangerZone}>
          {confirmDelete ? (
            <>
              <span style={{ color: '#ff3366', fontSize: 11 }}>DELETE_PERMANENTLY?</span>
              <button onClick={() => setConfirmDelete(false)} style={styles.secondaryBtn}>CANCEL</button>
              <button onClick={() => onDelete(question.id)}
                style={{ ...styles.secondaryBtn, color: '#ff3366', borderColor: '#ff3366' }}>
                CONFIRM_DELETE
              </button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)} style={styles.deleteBtn}>
              <Trash2 size={12} /><span>DELETE</span>
            </button>
          )}
        </div>
      </div>

      {lightbox && (
        <div style={styles.lightbox} onClick={() => setLightbox(null)}>
          <button onClick={() => setLightbox(null)} style={styles.lightboxClose} type="button">
            <X size={20} />
          </button>
          <img src={lightbox.dataUrl} alt={lightbox.name}
            style={styles.lightboxImg} onClick={(e) => e.stopPropagation()} />
          <div style={styles.lightboxName}>{lightbox.name}</div>
        </div>
      )}
    </main>
  );
}

function Field({ label, children }) {
  return (
    <div style={styles.field}>
      <label style={styles.label}>{label}</label>
      {children}
    </div>
  );
}

function Dots() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setN(x => (x + 1) % 4), 400);
    return () => clearInterval(i);
  }, []);
  return <span style={{ display: 'inline-block', minWidth: 18, textAlign: 'left' }}>{'.'.repeat(n)}</span>;
}

function Footer() {
  return (
    <footer style={styles.footer}>
      <div style={styles.footerLine}>
        <span style={styles.footerDim}>v1.0</span>
        <span style={styles.footerDim}>·</span>
        <span style={styles.footerDim}>SIGNAL_OVER_NOISE</span>
      </div>
    </footer>
  );
}

function CRTBackground() {
  return (
    <>
      <div style={styles.crtScanlines} />
      <div style={styles.crtVignette} />
      <div style={styles.crtGrid} />
    </>
  );
}

const mono = "'IBM Plex Mono', 'JetBrains Mono', 'Courier New', monospace";
const sans = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";

const styles = {
  app: { minHeight: '100vh', background: '#0a0c0e', color: '#e8e8e8', fontFamily: mono, fontSize: 13, position: 'relative', overflow: 'hidden' },
  container: { maxWidth: 720, margin: '0 auto', padding: '24px 20px 40px', position: 'relative', zIndex: 2 },
  crtScanlines: { position: 'fixed', inset: 0, pointerEvents: 'none', background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px, rgba(0,255,136,0.012) 2px, rgba(0,255,136,0.012) 3px)', zIndex: 1 },
  crtVignette: { position: 'fixed', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 100%)', zIndex: 1 },
  crtGrid: { position: 'fixed', inset: 0, pointerEvents: 'none', backgroundImage: 'linear-gradient(rgba(0,255,136,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,136,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px', zIndex: 0 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 24, borderBottom: '1px solid #1a1f25', marginBottom: 32, gap: 16, flexWrap: 'wrap' },
  headerLeft: { display: 'flex', flexDirection: 'column', gap: 6 },
  logo: { fontSize: 14, letterSpacing: '0.05em', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 },
  logoBracket: { color: '#00ff88' },
  logoText: { color: '#e8e8e8', fontWeight: 600 },
  logoSlash: { color: '#3a4046', margin: '0 6px' },
  logoSub: { color: '#888', letterSpacing: '0.1em' },
  statusLine: { fontSize: 10, color: '#5a6066', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: 8 },
  statusDot: { width: 6, height: 6, borderRadius: 0, background: '#00ff88', boxShadow: '0 0 6px #00ff88', animation: 'pulse 2s ease-in-out infinite' },
  nav: { display: 'flex', gap: 8 },
  navBtn: { background: 'transparent', border: '1px solid #2a2f35', color: '#888', padding: '6px 10px', fontFamily: mono, fontSize: 10, letterSpacing: '0.1em', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, transition: 'all 0.15s' },
  main: { minHeight: 400 },
  loading: { padding: 60, textAlign: 'center', color: '#5a6066', letterSpacing: '0.1em' },
  intro: { marginBottom: 32 },
  introLabel: { fontSize: 10, color: '#00ff88', letterSpacing: '0.15em', marginBottom: 12 },
  h1: { fontFamily: sans, fontSize: 32, fontWeight: 300, letterSpacing: '-0.02em', margin: 0, color: '#fff', lineHeight: 1.1 },
  lede: { fontFamily: sans, fontSize: 15, color: '#9aa0a6', lineHeight: 1.5, margin: '12px 0 0', maxWidth: 520 },
  form: { display: 'flex', flexDirection: 'column', gap: 20 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 10, color: '#888', letterSpacing: '0.15em' },
  input: { background: '#12161a', border: '1px solid #2a2f35', color: '#e8e8e8', padding: '10px 12px', fontFamily: mono, fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box', transition: 'border-color 0.15s' },
  textarea: { background: '#12161a', border: '1px solid #2a2f35', color: '#e8e8e8', padding: '12px', fontFamily: mono, fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box', resize: 'vertical', lineHeight: 1.5 },
  counter: { fontSize: 10, color: '#5a6066', textAlign: 'right', letterSpacing: '0.1em' },
  errorBox: { color: '#ff3366', fontSize: 11, letterSpacing: '0.1em', padding: '8px 12px', border: '1px solid #ff336640', background: '#ff336610' },
  submitBtn: { background: '#00ff88', color: '#0a0c0e', border: 'none', padding: '14px 20px', fontFamily: mono, fontSize: 12, fontWeight: 600, letterSpacing: '0.15em', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 8, transition: 'all 0.15s' },
  secondaryBtn: { background: 'transparent', color: '#888', border: '1px solid #2a2f35', padding: '12px 16px', fontFamily: mono, fontSize: 11, letterSpacing: '0.15em', cursor: 'pointer', transition: 'all 0.15s' },
  eyeBtn: { position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', padding: 6, display: 'flex' },
  successCard: { border: '1px solid #00ff8840', background: '#00ff8808', padding: 40, textAlign: 'center', position: 'relative', overflow: 'hidden' },
  successIcon: { width: 56, height: 56, margin: '0 auto 20px', border: '1px solid #00ff88', color: '#00ff88', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 20px #00ff8830' },
  successTitle: { fontSize: 14, color: '#00ff88', letterSpacing: '0.2em', marginBottom: 10 },
  successSub: { fontFamily: sans, fontSize: 14, color: '#9aa0a6' },
  scanline: { position: 'absolute', left: 0, right: 0, top: 0, height: 2, background: 'linear-gradient(90deg, transparent, #00ff88, transparent)', animation: 'scanline 2s linear infinite' },
  loginCard: { border: '1px solid #2a2f35', background: '#0f1216', padding: 32, maxWidth: 420, margin: '40px auto 0' },
  loginIcon: { width: 40, height: 40, border: '1px solid #2a2f35', color: '#00d9ff', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  adminHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16, marginBottom: 20 },
  filterRow: { display: 'flex', gap: 6 },
  filterPill: { background: 'transparent', border: '1px solid', padding: '6px 10px', fontFamily: mono, fontSize: 10, letterSpacing: '0.15em', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, transition: 'all 0.15s' },
  filterCount: { fontSize: 10, fontWeight: 600 },
  searchRow: { display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #2a2f35', background: '#12161a', padding: '10px 12px', marginBottom: 16 },
  searchInput: { flex: 1, background: 'transparent', border: 'none', color: '#e8e8e8', fontFamily: mono, fontSize: 12, outline: 'none', letterSpacing: '0.05em' },
  questionList: { display: 'flex', flexDirection: 'column', gap: 8 },
  questionRow: { background: '#0f1216', border: '1px solid #1a1f25', padding: 16, cursor: 'pointer', textAlign: 'left', fontFamily: mono, color: '#e8e8e8', display: 'flex', gap: 16, alignItems: 'flex-start', transition: 'all 0.15s' },
  statusBadge: { fontSize: 9, letterSpacing: '0.15em', border: '1px solid', padding: '3px 6px', flexShrink: 0 },
  questionContent: { flex: 1, minWidth: 0 },
  questionMeta: { display: 'flex', gap: 12, fontSize: 11, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' },
  questionName: { color: '#e8e8e8', fontWeight: 500 },
  questionEmail: { color: '#5a6066' },
  questionAttach: { display: 'flex', alignItems: 'center', gap: 4, color: '#00d9ff', fontSize: 10, letterSpacing: '0.05em' },
  questionTime: { color: '#5a6066', marginLeft: 'auto' },
  questionPreview: { fontFamily: sans, fontSize: 14, color: '#9aa0a6', lineHeight: 1.5 },
  emptyState: { border: '1px dashed #2a2f35', padding: 48, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
  emptyText: { color: '#888', fontSize: 12, letterSpacing: '0.15em' },
  emptyHint: { fontFamily: sans, color: '#5a6066', fontSize: 13 },
  backBtn: { background: 'transparent', border: 'none', color: '#888', fontFamily: mono, fontSize: 10, letterSpacing: '0.15em', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: 0, marginBottom: 20 },
  detailCard: { border: '1px solid #2a2f35', background: '#0f1216', padding: 24 },
  detailMeta: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  detailName: { fontSize: 14, color: '#fff', fontWeight: 500 },
  detailEmail: { fontSize: 11, color: '#5a6066', marginTop: 4 },
  detailTime: { fontSize: 10, color: '#5a6066', letterSpacing: '0.1em' },
  detailDivider: { height: 1, background: '#1a1f25', margin: '20px 0' },
  detailLabel: { fontSize: 10, color: '#00ff88', letterSpacing: '0.15em', marginBottom: 12 },
  detailQuestion: { fontFamily: sans, fontSize: 16, color: '#e8e8e8', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  detailReply: { fontFamily: sans, fontSize: 15, color: '#9aa0a6', lineHeight: 1.6, padding: 16, background: '#12161a', border: '1px solid #1a1f25', borderLeft: '2px solid #00d9ff', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  detailActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, flexWrap: 'wrap' },
  dangerZone: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  deleteBtn: { background: 'transparent', color: '#5a6066', border: '1px solid #2a2f35', padding: '8px 12px', fontFamily: mono, fontSize: 10, letterSpacing: '0.15em', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, transition: 'all 0.15s' },
  footer: { marginTop: 60, paddingTop: 20, borderTop: '1px solid #1a1f25', textAlign: 'center' },
  footerLine: { display: 'flex', justifyContent: 'center', gap: 10 },
  footerDim: { fontSize: 10, color: '#3a4046', letterSpacing: '0.15em' },
  dropZone: { border: '1px dashed #2a2f35', background: '#12161a', padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, cursor: 'pointer', transition: 'all 0.15s' },
  dropText: { fontSize: 11, color: '#888', letterSpacing: '0.15em' },
  dropHint: { fontSize: 9, color: '#5a6066', letterSpacing: '0.1em' },
  imageGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginTop: 12 },
  imageThumb: { position: 'relative', border: '1px solid #2a2f35', background: '#0a0c0e', aspectRatio: '1', overflow: 'hidden' },
  imageThumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  imageThumbName: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: '4px 6px', background: 'linear-gradient(to top, rgba(0,0,0,0.9), transparent)', fontSize: 9, color: '#9aa0a6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.05em' },
  imageRemove: { position: 'absolute', top: 4, right: 4, width: 22, height: 22, background: 'rgba(0,0,0,0.8)', border: '1px solid #2a2f35', color: '#e8e8e8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, transition: 'all 0.15s' },
  detailImageGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 },
  detailImageBtn: { background: 'transparent', border: '1px solid #2a2f35', padding: 0, cursor: 'pointer', aspectRatio: '1', overflow: 'hidden', transition: 'all 0.15s' },
  detailImageImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  lightbox: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.95)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', padding: 40, cursor: 'pointer' },
  lightboxClose: { position: 'absolute', top: 20, right: 20, background: 'transparent', border: '1px solid #2a2f35', color: '#e8e8e8', width: 40, height: 40, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  lightboxImg: { maxWidth: '100%', maxHeight: 'calc(100vh - 120px)', objectFit: 'contain', cursor: 'default' },
  lightboxName: { marginTop: 16, fontSize: 11, color: '#888', letterSpacing: '0.1em' },
};
