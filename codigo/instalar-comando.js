// O comando que instala a versão nova e reabre o app (usado pelo atualizar.js e pelo teste do instalador de verdade,
// testes/pacote/e2e.js, que roda exatamente este comando). Testado em 18/11/2026: o --force-run do próprio instalador
// não reabriu o app; o PowerShell aberto direto pelo app morre junto com ele (e, com "detached", nem começa); aberto pelo
// "start" do cmd, ele segue vivo depois que o app fecha. O comando vai codificado (-EncodedCommand), sem depender das
// aspas da linha de comando.
const aspas = s => `'${String(s).replace(/'/g, "''")}'`;
const comandoInstalar = (setup, exe) =>
  `Start-Process -FilePath ${aspas(setup)} -ArgumentList '/S' -Wait; Start-Sleep -Seconds 1; if (Test-Path -LiteralPath ${aspas(exe)}) { Start-Process -FilePath ${aspas(exe)} }`;
// spawn('cmd.exe', argsInstalar(...), { detached: true, stdio: 'ignore', windowsHide: true })
const argsInstalar = (setup, exe) => ['/d', '/c', 'start', '""', '/min', 'powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
  '-EncodedCommand', Buffer.from(comandoInstalar(setup, exe), 'utf16le').toString('base64')];
module.exports = { comandoInstalar, argsInstalar };
