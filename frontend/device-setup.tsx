import type { FormEvent } from 'react';
import type { DiscoveredDevice, Status } from './types';

export function DeviceSetup({ open, onClose, status, devices, busy, message, onLoadDevices, onToggleDevice, onSaveDevices }: {
  open: boolean;
  onClose: () => void;
  status: Status | null;
  devices: DiscoveredDevice[];
  busy: boolean;
  message: string;
  onLoadDevices: () => void;
  onToggleDevice: (index: number, selected: boolean) => void;
  onSaveDevices: () => Promise<boolean>;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSaveDevices().then(saved => { if (saved) onClose(); });
  };
  return <section id="setup" className="setup card" hidden={!open}>
    <div className="section-title"><h2>Deine Heizung verbinden</h2><button id="setup-close" className="text-button" onClick={onClose}>Schließen</button></div>
    <ol><li>Im <a href="https://app.developer.viessmann-climatesolutions.com" target="_blank" rel="noreferrer">Viessmann-Developer-Portal</a> mit deinem ViCare-Konto anmelden und einen API-Client anlegen.</li><li>Redirect-URI <code id="redirect-uri">{`http://localhost:${location.port}/auth/callback`}</code> registrieren. PKCE verwenden.</li><li>Client-ID lokal in <code>.env</code> eintragen, <code>DEMO_MODE=false</code> setzen und die App neu starten.</li><li>Hier bei Viessmann anmelden und deine Heizgeräte auswählen. Das Passwort wird nur bei Viessmann eingegeben.</li></ol>
    <div className="setup-actions"><a id="login" className="button primary" href="/auth/login" hidden={!!status?.demo}>{status?.connected ? 'Erneut bei Viessmann anmelden ↗' : 'Mit Viessmann verbinden ↗'}</a><button id="load-devices" className="button secondary" hidden={status?.demo || !status?.connected} disabled={busy} onClick={onLoadDevices}>Geräteauswahl laden</button></div>
    <form id="device-form" hidden={!devices.length} onSubmit={submit}><fieldset><legend>Heizgeräte für die automatische Erfassung</legend><div id="device-options">{devices.map(device => <label className="device-choice" key={device.index}><input type="checkbox" checked={device.selected} onChange={event => onToggleDevice(device.index, event.target.checked)}/><span>{device.name} · Gerät {device.deviceId}</span></label>)}</div></fieldset><button className="button primary" type="submit" disabled={busy}>Auswahl speichern</button><p>Jede Heizung benötigt eine eigene API-Abfrage pro Intervall. Bitte das API-Kontingent beachten.</p></form>
    <p id="setup-message" role="status">{message}</p>
  </section>;
}
