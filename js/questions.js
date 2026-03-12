// ── ADD QUESTION MODAL ────────────────────────────────────────────

function openAddModal() {
  const sel = document.getElementById('m-stage');
  sel.innerHTML = '';
  stages.forEach((st, i) => {
    const opt = document.createElement('option');
    opt.value = st.id;
    opt.textContent = `Section ${i + 1} — ${st.label}`;
    sel.appendChild(opt);
  });
  document.getElementById('add-overlay').classList.add('open');
}

function closeAddModal() {
  document.getElementById('add-overlay').classList.remove('open');
  document.getElementById('m-q').value = '';
  document.getElementById('m-msg').value = '';
}

function addQuestion() {
  const stage = document.getElementById('m-stage').value;
  const text  = document.getElementById('m-q').value.trim();
  const msg   = document.getElementById('m-msg').value.trim();
  if (!text) { toast('Please enter a question', 'i'); return; }

  const sq     = questions.filter(q => q.stage === stage);
  const stIdx  = stages.findIndex(s => s.id === stage);
  const id     = `q-${stage}-${sq.length + 1}-${Date.now()}`;
  const num    = `Q${stIdx + 1}.${sq.length + 1}*`;
  const thread = msg ? [{ role: currentRole, text: msg, ts: new Date().toISOString() }] : [];
  const newQ   = { id, stage, num, text, thread, resolved: false };

  questions.push(newQ);
  save();
  dbInsertQuestion(newQ); // Supabase
  if (msg) dbInsertMessage(id, currentRole, msg); // Supabase: seed opening message

  renderStageBlocks();
  stages.forEach(st => renderStage(st.id));
  updateGlobal();
  updatePills();
  renderOverview();
  closeAddModal();
  showStage(stage, null);
  toast('Question added', 'ok');
}
