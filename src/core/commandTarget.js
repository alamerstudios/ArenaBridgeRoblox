export function editableClients(session) {
  return session.editableClients();
}

export function playtestReporterId(editClientId) {
  return `${editClientId}:play-server`;
}

function reporterFor(clients, editClientId) {
  return clients.find((client) => client.dataModelRole === 'play-server' && client.editClientId === editClientId);
}

/**
 * Resolve against the editor Place. Only status and stop may cross into the
 * second plugin DataModel. A stop issued during start-up waits in the queue
 * for the reporter's deterministic client ID instead of failing immediately.
 */
export function resolveStudioTarget(session, action, requestedClientId) {
  const all = session.activeClients();
  const editable = session.editableClients();
  if (!requestedClientId && editable.length === 1) {
    return resolveStudioTarget(session, action, editable[0].id);
  }
  if (!requestedClientId) {
    return { targetClientId: null, clients: editable, all };
  }

  const requested = all.find((client) => client.id === requestedClientId);
  if (!requested || requested.dataModelRole === 'play-server') {
    return { error: 'STUDIO_CLIENT_OFFLINE', clients: editable, all };
  }

  if (action === 'stop_game' || action === 'get_play_state') {
    const reporter = reporterFor(all, requested.id);
    if (reporter) {
      return { targetClientId: reporter.id, requested, clients: editable, all, forwardedToPlaytest: true };
    }
    const separatePlaytest = requested.playtestActive === true
      && requested.isRunning !== true
      && requested.playtestMode !== 'simulation';
    if (action === 'stop_game' && separatePlaytest) {
      return {
        targetClientId: playtestReporterId(requested.id),
        requested,
        clients: editable,
        all,
        awaitingPlaytestReporter: true,
      };
    }
  }

  return { targetClientId: requestedClientId, requested, clients: editable, all };
}
