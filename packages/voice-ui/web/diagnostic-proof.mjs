import { runBrowserDiagnosticProof } from "./diagnostic-host.mjs";

const target = document.querySelector("#result");
try {
  const report = await runBrowserDiagnosticProof();
  document.body.dataset.result = report.status;
  document.body.dataset.action = report.finding.action;
  document.body.dataset.providerRevision = report.providerIdentity.revision;
  target.textContent = JSON.stringify(report);
} catch (error) {
  document.body.dataset.result = "FAIL";
  target.textContent = String(error?.stack ?? error);
}
