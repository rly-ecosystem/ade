import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import Prism from 'prismjs';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-diff';

Prism.manual = true;
const decoder = document.createElement('textarea');
function text(value: string): string {
  if (!value.includes('&')) return value;
  decoder.innerHTML = value.replace(/</g, '&lt;');
  return decoder.value;
}
function external(href: string): string | null {
  try { const url = new URL(text(href)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const [error, setError] = useState(''), url = external(href);
  if (!url) return <span>{children} <code>{text(href)}</code></span>;
  return <><a href={url} rel="noreferrer noopener" onClick={event => { event.preventDefault(); void window.ade.openExternal(url).then(result => { if (!result.ok) setError(result.error); }).catch(() => setError('Не удалось открыть ссылку.')); }}>{children}</a>{error ? <span role="alert" className="local-link-error">{error}</span> : null}</>;
}

function syntax(tokens: (string | Prism.Token)[], prefix = ''): ReactNode {
  return tokens.map((token, index) => {
    if (typeof token === 'string') return token;
    const aliases = typeof token.alias === 'string' ? [token.alias] : token.alias || [];
    const classes = ['token', token.type, ...aliases].filter(name => /^[a-z0-9_-]+$/i.test(name)).join(' ');
    return <span key={prefix + index} className={classes}>{typeof token.content === 'string' ? token.content : syntax(Array.isArray(token.content) ? token.content : [token.content], prefix + index + '-')}</span>;
  });
}

function Code({ value, language }: { value: string; language: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const grammar = Object.hasOwn(Prism.languages, language) ? Prism.languages[language] : undefined;
  const highlighted = useMemo(() => grammar && value.length <= 64000 ? syntax(Prism.tokenize(value, grammar)) : value, [value, grammar]);
  useEffect(() => { setCopied(false); setError(''); }, [value]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  return <div className="local-code-block"><div className="local-code-bar"><span>{language || 'text'}</span><button type="button" disabled={!value} aria-label={copied ? 'Код скопирован' : 'Копировать код'} onClick={() => { void window.ade.copyText(value).then(result => { if (result.ok) setCopied(true); else setError(result.error); }).catch(() => setError('Не удалось скопировать код.')); }}>{copied ? 'Скопировано' : 'Копировать'}</button></div><pre><code>{highlighted}</code></pre>{error ? <p role="alert">{error}</p> : null}</div>;
}

function inline(tokens: Token[]): ReactNode {
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'strong': return <strong key={index}>{inline((token as Tokens.Strong).tokens)}</strong>;
      case 'em': return <em key={index}>{inline((token as Tokens.Em).tokens)}</em>;
      case 'del': return <del key={index}>{inline((token as Tokens.Del).tokens)}</del>;
      case 'codespan': return <code key={index}>{text(token.text)}</code>;
      case 'br': return <br key={index} />;
      case 'link': return <Link key={index} href={token.href}>{inline(token.tokens || [])}</Link>;
      case 'image': return <Link key={index} href={token.href}>Изображение: {text(token.text || token.href)}</Link>;
      case 'html': return token.raw;
      case 'escape': return token.text;
      case 'text': return token.tokens ? <span key={index}>{inline(token.tokens)}</span> : text(token.text);
      default: return token.raw;
    }
  });
}

function blocks(tokens: Token[]): ReactNode {
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'heading': {
        const value = token as Tokens.Heading, level = Math.min(4, Math.max(2, value.depth));
        return level === 2 ? <h2 key={index}>{inline(value.tokens)}</h2> : level === 3 ? <h3 key={index}>{inline(value.tokens)}</h3> : <h4 key={index}>{inline(value.tokens)}</h4>;
      }
      case 'paragraph': return <p key={index}>{inline(token.tokens || [])}</p>;
      case 'text': return <p key={index}>{token.tokens ? inline(token.tokens) : text(token.text)}</p>;
      case 'code': return <Code key={index} value={token.text} language={token.lang?.split(/\s/)[0]?.toLowerCase() || ''} />;
      case 'blockquote': return <blockquote key={index}>{blocks(token.tokens || [])}</blockquote>;
      case 'hr': return <hr key={index} />;
      case 'list': {
        const value = token as Tokens.List;
        const items = value.items.map((item, position) => <li key={position}>{item.task ? <span className="local-task-mark" aria-label={item.checked ? 'Выполнено' : 'Не выполнено'}>{item.checked ? '☑' : '☐'}</span> : null}{blocks(item.tokens)}</li>);
        return value.ordered ? <ol key={index} start={value.start || 1}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case 'table': {
        const value = token as Tokens.Table;
        return <div key={index} className="local-table-scroll"><table><thead><tr>{value.header.map((cell, position) => <th key={position} style={{ textAlign: value.align[position] || 'left' }}>{inline(cell.tokens)}</th>)}</tr></thead><tbody>{value.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, position) => <td key={position} style={{ textAlign: value.align[position] || 'left' }}>{inline(cell.tokens)}</td>)}</tr>)}</tbody></table></div>;
      }
      case 'html': return <p key={index}>{token.raw}</p>;
      default: return <p key={index}>{token.raw}</p>;
    }
  });
}

export function Markdown({ value }: { value: string }) {
  const content = useMemo(() => blocks(marked.lexer(value, { gfm: true, breaks: false })), [value]);
  return <div className="local-markdown">{content}</div>;
}
