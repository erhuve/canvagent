const invoke = (command) => window.__TAURI__.core.invoke(command);
const choose = document.getElementById('choose');
const recent = document.getElementById('recent');
const status = document.getElementById('status');
const error = document.getElementById('error');
let busy = false;
async function open(command) {
  if (busy) return;
  busy = true;
  choose.disabled = recent.disabled = true;
  error.hidden = true;
  status.textContent = 'Opening your workspace…';
  try { await invoke(command); }
  catch (message) { error.textContent = String(message); error.hidden = false; }
  finally {
    busy = false;
    choose.disabled = recent.disabled = false;
    status.textContent = 'Your projects and canvas stay on this machine.';
  }
}
choose.addEventListener('click', () => open('choose_workspace'));
recent.addEventListener('click', () => open('reopen_workspace'));
window.addEventListener('canvagent:open-workspace', () => open('choose_workspace'));
window.addEventListener('canvagent:close', () => invoke('quit_application'));
invoke('desktop_info').then(info => {
  if (!info.lastWorkspace) return;
  document.getElementById('recent-name').textContent = info.lastWorkspace.split(/[\\/]/).filter(Boolean).pop();
  document.getElementById('recent-path').textContent = info.lastWorkspace;
  recent.hidden = false;
}).catch(message => { error.textContent = String(message); error.hidden = false; });
