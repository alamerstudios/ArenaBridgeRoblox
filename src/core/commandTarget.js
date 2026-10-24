export function editableClients(session) {
  return session.activeClients().filter((client) => !client.dataModelRole || client.dataModelRole === 'edit');
}

/**
 * Resolve a command against the editor Place. Stop is forwarded to the small
 * server-DataModel reporter when a real Studio playtest is active.
 */
export function resolveStudioTarget(session, action, requestedClientId) {
  const all = session.activeClients();
  const editable = all.filter((client) => !client.dataModelRole || client.dataModelRole === 'edit');
  if (requestedClientId) {
    const requested = all.find((client) => client.id === requestedClientId);
    if (!requested) return { error: 'STUDIO_CLIENT_OFFLINE', clients: editable, all };
    if (action === 'stop_game' && requested.dataModelRole !== 'play-server') {
      const reporter = all.find((client) => client.dataModelRole === 'play-server' && client.editClientId === requested.id);
      if (reporter) return { targetClientId: reporter.id, requested, clients: editable, all, forwardedToPlaytest: true };
      if (requested.playtestActive === true) {
        return { error: 'PLAYTEST_REPORTER_OFFLINE', requested, clients: editable, all };
      }
    }
    return { targetClientId: requestedClientId, requested, clients: editable, all };
  }
  return { targetClientId: editable.length === 1 ? editable[0].id : null, clients: editable, all };
}
