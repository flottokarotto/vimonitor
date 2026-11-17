import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, message, post, seriesKey } from './api';
import { colors } from './chart';
import type { DiscoveredDevice, Insights, Kind, Point, Series, Status } from './types';
import type { Line } from './chart';

export function useDashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [serverDown, setServerDown] = useState(false);
  const [setupMessage, setSetupMessage] = useState('');
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [discovered, setDiscovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hours, setHours] = useState(24);
  const [flow, setFlow] = useState('');
  const [water, setWater] = useState('');
  const [comparison, setComparison] = useState<Set<string>>(new Set());
  const [histories, setHistories] = useState<Map<string, Point[]>>(new Map());
  const [refreshCount, setRefreshCount] = useState(0);
  const initialized = useRef<Set<string>>(new Set());
  const refreshLock = useRef(false);
  const activeVersion = useRef(0);

  const loadDevices = useCallback(async () => {
    setBusy(true);
    setSetupMessage('Verfügbare Geräte werden bei Viessmann abgefragt …');
    try {
      const result = await api<{ devices: DiscoveredDevice[] }>('/api/devices');
      setDevices(result.devices);
      setDiscovered(true);
      setSetupMessage(result.devices.length
        ? 'Bitte mindestens ein Heizgerät auswählen.'
        : 'Keine Geräte gefunden. ViCare-Konto, Gateway und API-Freigabe prüfen.');
    } catch (e) {
      setSetupMessage(message(e));
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    const version = ++activeVersion.current;
    try {
      const next = await api<Status>('/api/status');
      if (version !== activeVersion.current) return;
      setStatus(next);
      setServerDown(false);
      setError(next.error ?? '');
      setRefreshCount(count => count + 1);
      try {
        const result = await api<Insights>('/api/insights');
        if (version === activeVersion.current) {
          setInsights(result);
          setInsightsError(null);
        }
      } catch (e) {
        if (version === activeVersion.current) {
          setInsights(null);
          setInsightsError(message(e));
          setError(`Auswertung konnte nicht geladen werden: ${message(e)}`);
        }
      }
      if (next.connected && !next.demo && !next.device && !discovered) await loadDevices();
    } catch (e) {
      if (version === activeVersion.current) {
        setError(`Lokaler Server nicht erreichbar: ${message(e)}`);
        setInsights(null);
        setInsightsError(message(e));
        setHistories(new Map());
        setServerDown(true);
      }
    } finally {
      refreshLock.current = false;
      setRefreshing(false);
    }
  }, [discovered, loadDevices]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!status) return;
    const choose = (kind: Kind, previous: string) => status.sensors.some(item => item.sensor === previous)
      ? previous : status.sensors.find(item => item.kind === kind)?.sensor ?? '';
    setFlow(previous => choose('flow', previous));
    setWater(previous => choose('water', previous));
    const deviceIds = new Set(status.devices.map(device => device.id));
    initialized.current = new Set([...initialized.current].filter(id => deviceIds.has(id)));
    setComparison(previous => {
      const available = new Set(status.devices.flatMap(device =>
        device.sensors.map(sensor => seriesKey(device.id, sensor.sensor))));
      const next = new Set([...previous].filter(item => available.has(item)));
      for (const device of status.devices) {
        if (!device.sensors.length || initialized.current.has(device.id)) continue;
        for (const kind of ['flow', 'water'] as const) {
          const sensor = device.sensors.find(item => item.kind === kind);
          if (sensor) next.add(seriesKey(device.id, sensor.sensor));
        }
        initialized.current.add(device.id);
      }
      return next;
    });
  }, [status]);

  const series: Series[] = useMemo(() => {
    const result = (status?.devices ?? []).flatMap(device => device.sensors.map(sensor => ({
      ...sensor,
      device: device.id,
      key: seriesKey(device.id, sensor.sensor),
      display: (status?.devices.length ?? 0) > 1 ? `${device.name} · ${sensor.label}` : sensor.label,
    })));
    return result.map((item, index) => ({ ...item, index }));
  }, [status]);

  const requestKeys = useMemo(() => {
    const keys = new Set(comparison);
    if (status?.activeDevice) {
      for (const sensor of [flow, water]) if (sensor) keys.add(seriesKey(status.activeDevice, sensor));
    }
    return [...keys].sort();
  }, [comparison, flow, water, status?.activeDevice]);
  const requestSignature = JSON.stringify(requestKeys);

  useEffect(() => {
    let active = true;
    const keys: string[] = JSON.parse(requestSignature);
    if (!keys.length) {
      setHistories(new Map());
      return;
    }
    void Promise.all(keys.map(async item => {
      const [device, sensor]: [string, string] = JSON.parse(item);
      const result = await api<{ points: Point[] }>(
        `/api/history?hours=${hours}&sensor=${encodeURIComponent(sensor)}&device=${encodeURIComponent(device)}`,
      );
      return [item, result.points] as const;
    })).then(results => {
      if (active) setHistories(new Map(results));
    }).catch(e => {
      if (active) {
        setHistories(new Map());
        setError(`Verlauf konnte nicht geladen werden: ${message(e)}`);
      }
    });
    return () => { active = false; };
  }, [hours, requestSignature, refreshCount]);

  const setActive = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await api('/api/active-device', post({ id }));
      setInsights(null);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const saveDevices = useCallback(async () => {
    setBusy(true);
    try {
      await api('/api/devices', post({
        indexes: devices.filter(item => item.selected).map(item => item.index),
      }));
      setSetupMessage('Auswahl gespeichert. Die automatische Erfassung ist aktiv.');
      await refresh();
      return true;
    } catch (e) {
      setSetupMessage(message(e));
      await refresh();
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [devices, refresh]);

  const selectedSeries = series.filter(item => comparison.has(item.key));
  const emptySeries = selectedSeries.filter(item => !histories.get(item.key)?.length);
  const comparisonLines: Line[] = selectedSeries.map(item => ({
    label: item.display,
    points: histories.get(item.key) ?? [],
    color: colors[item.index % colors.length]!,
    dash: item.index >= colors.length ? item.index >= colors.length * 2 ? [2, 3] : [7, 4] : [],
    fill: false,
  }));
  const toggleSeries = useCallback((sensor: string, checked: boolean) => {
    setComparison(previous => {
      const next = new Set(previous);
      if (checked) next.add(sensor);
      else next.delete(sensor);
      return next;
    });
  }, []);

  return {
    status, insights, insightsError, error, serverDown, setupMessage, devices, busy, refreshing,
    hours, setHours, flow, setFlow, water, setWater, histories, series,
    selectedSeries, emptySeries, comparisonLines,
    setDevices, refresh, loadDevices, setActive, saveDevices, toggleSeries,
  };
}
