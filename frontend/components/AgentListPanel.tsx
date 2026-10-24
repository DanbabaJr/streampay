import React from 'react';

export interface AgentPanelProps {
  streamId: string;
  agents: string[];
  onAddAgent: (agent: string) => void;
  onRemoveAgent: (agent: string) => void;
}

export const AgentListPanel: React.FC<AgentPanelProps> = ({ streamId, agents, onAddAgent, onRemoveAgent }) => {
  const [newAgent, setNewAgent] = React.useState('');

  return (
    <div className="bg-white shadow rounded-lg p-6 max-w-md mx-auto">
      <h3 className="text-lg font-medium text-gray-900 mb-4">Authorized Withdrawer Agents (Stream #{streamId})</h3>
      <ul className="divide-y divide-gray-200 mb-4">
        {agents.map((agent, index) => (
          <li key={index} className="py-2 flex justify-between items-center text-sm font-mono">
            <span>{agent}</span>
            <button
              onClick={() => onRemoveAgent(agent)}
              className="text-red-600 hover:text-red-900 text-xs font-sans"
            >
              Remove
            </button>
          </li>
        ))}
        {agents.length === 0 && <p className="text-sm text-gray-500">No agents authorized.</p>}
      </ul>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Agent address..."
          value={newAgent}
          onChange={(e) => setNewAgent(e.target.value)}
          className="flex-1 border rounded px-3 py-1 text-sm font-mono"
        />
        <button
          onClick={() => { if (newAgent) { onAddAgent(newAgent); setNewAgent(''); }}}
          className="bg-indigo-600 text-white px-4 py-1 rounded text-sm hover:bg-indigo-700"
        >
          Add Agent
        </button>
      </div>
    </div>
  );
};
