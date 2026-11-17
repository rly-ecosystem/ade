const { DatabaseSync } = require('node:sqlite');

module.exports = function seedInsights(filename, now, projectA, projectB) {
  const db = new DatabaseSync(filename);
  const date = daysAgo => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).toISOString();
  const task = db.prepare('INSERT INTO tasks(id,projectId,title,status,createdAt,updatedAt,archived) VALUES (?,?,?,?,?,?,?)');
  const point = db.prepare("INSERT INTO checkpoints (id,taskId,data) VALUES (?,?, '{}')");
  const run = db.prepare('INSERT INTO runs(id,taskId,projectId,provider,profileId,model,status,generation,requestId,checkpointId,startedAt,usageData) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const acceptance = db.prepare("INSERT INTO acceptances VALUES(?,?, 'digest',0,'test','manual',?,?)");
  db.exec('BEGIN');
  try {
    for (const [name, project, status, archived] of [['a', projectA, 'accepted', 1], ['b', projectB, 'review', 0], ['c', projectA, 'waiting', 0]]) {
      task.run(name, project, 'Private task ' + name, status, date(29), date(0), archived);
      point.run(name, name);
    }
    const records = [
      ['a', 'codex', null, 'completed', 6, 1000],
      ['a', 'claude', 'shared-claude', 'completed', 3, 580],
      ['b', 'codex', null, 'completed', 1, 0],
      ['b', 'claude', 'shared-claude', 'completed', 0, 35],
      ['c', 'claude', 'a6f6fb70-6e2f-40ab-96cb-b9e3de36f98d', 'running', 0, null],
      ['b', 'codex', null, 'failed', 7, 1200],
      ['c', 'codex', null, 'failed', 29, 75],
      ['b', 'codex', null, 'completed', 30, 5000],
    ];
    for (const [index, [taskId, provider, profileId, status, daysAgo, input]] of records.entries()) {
      const usage = input === null ? null : JSON.stringify({ input, output: Math.floor(input / 4), cachedInput: Math.floor(input / 2), cacheWrite: 0 });
      run.run('run' + index, taskId, taskId === 'b' ? projectB : projectA, provider, profileId, '', status, index + 1, 'request' + index, taskId, date(daysAgo), usage);
    }
    acceptance.run('a', 'run1', date(1), 0);
    acceptance.run('b', 'run3', date(0), 1);
    db.exec('COMMIT');
  } finally { db.close(); }
};
