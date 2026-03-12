// ── STAGE MANAGEMENT ──────────────────────────────────────────────

function openStageModal() {
  document.getElementById('stage-overlay').classList.add('open');
  document.getElementById('sm-label').focus();
}

function closeStageModal() {
  document.getElementById('stage-overlay').classList.remove('open');
  document.getElementById('sm-label').value = '';
  document.getElementById('sm-emoji').value = '';
}

function addStage() {
  const label = document.getElementById('sm-label').value.trim();
  const emoji = document.getElementById('sm-emoji').value.trim() || '📁';
  if (!label) { toast('Please enter a section name', 'i'); return; }

  const id        = 'stage-' + Date.now();
  const sortOrder = stages.length + 1;
  const newStage  = { id, label, emoji };

  stages.push(newStage);
  save();
  dbInsertStage(newStage, sortOrder); // Supabase
  renderSidebar();
  renderStageBlocks();
  updateGlobal();
  renderOverview();
  closeStageModal();
  showStage(id, null);
  toast('Section added', 'ok');
}

function deleteStage(stageId) {
  const st = stages.find(s => s.id === stageId);
  if (!st) return;
  const qCount = questions.filter(q => q.stage === stageId).length;
  const msg = qCount > 0
    ? `Delete section "${st.label}"?\n\nThis will also delete ${qCount} question${qCount > 1 ? 's' : ''} inside it.\n\nThis cannot be undone.`
    : `Delete section "${st.label}"?\n\nThis cannot be undone.`;
  if (!confirm(msg)) return;

  questions = questions.filter(q => q.stage !== stageId);
  stages    = stages.filter(s => s.id !== stageId);
  save();
  dbDeleteStage(stageId); // Supabase (cascade removes questions + messages)
  renderSidebar();
  renderStageBlocks();
  stages.forEach(s => renderStage(s.id));
  updateGlobal();
  renderOverview();
  showStage('overview', null);
  toast(`Section "${st.label}" deleted`, 'i');
}
