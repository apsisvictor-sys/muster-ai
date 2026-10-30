"""Environment for the A0 gate's throwaway Pi agent.

The agent loads the live Muster extension, which writes a lane card, a lane
registry row, programme/decision state and (when CONCORD_REPO_ROOT is set) joins
the live Concord workspace. Every such location is pointed at a fresh temp root
so the test leaves nothing in the live registry. The names below are the ones
`extensions/muster` and `extensions/lib` read; the test in
`herdr-gate-isolation.test.ts` fails when a new state-path name appears unlisted.
"""
import os
import tempfile

# Live-bus identity: a throwaway lane must never join the orchestrator's workspace.
DROPPED = ('CONCORD_REPO_ROOT', 'CONCORD_AGENT_ID', 'CONCORD_TASK', 'MUSTER_REPO_ALIAS',
           'PI_LANES_REPO_ROOT', 'PI_MUSTER_BRIEF', 'PI_MUSTER_LANE_PROGRAMME', 'PI_LANES_TMUX_SESSION')

# env name -> path relative to the temp root.
ISOLATED = {
    'PI_MUSTER_STATE_DIR': 'state/muster',  # pi-lanes.json lands beside it, in state/
    'PI_LANES_JSON': 'state/pi-lanes.json',
    'PI_MUSTER_CONTROL_DIR': 'control',
    'PI_MUSTER_DECISIONS_DIR': 'decisions',  # the relay socket defaults inside it
    'PI_MUSTER_RELAY_SOCKET': 'decisions/relay.sock',
    'PI_MUSTER_PROJECTS_FILE': 'muster-projects.json',
    'PI_MUSTER_SUPERVISOR_STATE': 'supervisor.json',
    'PI_AGILE_PROGRAMMES_DIR': 'programmes',
    'PI_AGILE_DECOMPOSITIONS_DIR': 'decompositions',
    'PI_ACTIVITY_LOG': 'activity.log',
    'PI_PROVIDER_WALLS_PATH': 'provider-walls.json',  # a wall the throwaway agent hits must not steer live routing
    'PI_TELEMETRY_DB_PATH': 'telemetry.db',  # the router's month: a throwaway agent spends in its own file
}


def isolated_env(base, root):
    """`base` with live-bus identity removed and every state path under `root`."""
    env = {key: value for key, value in base.items() if key not in DROPPED}
    for name, relative in ISOLATED.items():
        env[name] = os.path.join(root, relative)
    return env


def make_state_root():
    return tempfile.mkdtemp(prefix='a0-state-')
