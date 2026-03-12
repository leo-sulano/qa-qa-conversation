// ── EXPORT ────────────────────────────────────────────────────────

function exportMD() {
  let md = `# QA Dashboard — Chat Monitoring & Analysis\n**Exported:** ${new Date().toLocaleDateString('en-GB')}\n\n---\n\n`;
  stages.forEach((st, i) => {
    const sq   = questions.filter(q => q.stage === st.id);
    const done = sq.filter(q => q.resolved).length;
    md += `## ${st.emoji} Section ${i + 1} — ${st.label}\n*${done}/${sq.length} resolved*\n\n---\n\n`;
    sq.forEach(q => {
      md += `### ${q.num} — ${q.text}\n**Status:** ${q.resolved ? '✅ Resolved' : '🟡 Pending'}\n\n`;
      if (q.thread.length > 0) {
        md += `**Thread:**\n\n`;
        q.thread.forEach(m => {
          const who = m.role === 'admin' ? '👤 Admin' : '🏢 Client';
          md += `> **${who}** _(${fmtTime(m.ts)})_\n>\n`;
          m.text.split('\n').forEach(l => { md += `> ${l}\n`; });
          md += `\n`;
        });
      }
      md += `---\n\n`;
    });
  });

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = 'QA-Dashboard-Export.md';
  a.click();
  toast('Exported', 'ok');
}
