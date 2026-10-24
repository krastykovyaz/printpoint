// Keeps count of the sheets in the printer tray. The printer cannot report how many are loaded,
// so the owner says how many they put in and every printed order is subtracted.
export function createPaperTray(db, alertPercent = 90) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_tray (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      loaded INTEGER NOT NULL,
      remaining INTEGER NOT NULL,
      alert_level INTEGER NOT NULL DEFAULT 0
    )
  `);

  const read = () => db.prepare("SELECT loaded, remaining, alert_level FROM paper_tray WHERE id = 1").get() || null;

  return {
    status() {
      const row = read();
      return row && { loaded: row.loaded, remaining: row.remaining, percent: row.loaded ? Math.round((row.remaining / row.loaded) * 100) : 0 };
    },

    // Called when the owner refills the tray.
    load(sheets) {
      db.prepare(`
        INSERT INTO paper_tray (id, loaded, remaining, alert_level) VALUES (1, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET loaded = excluded.loaded, remaining = excluded.remaining, alert_level = 0
      `).run(sheets, sheets);
    },

    // Called after a job printed. Returns "empty" or "low" once per refill, otherwise null.
    use(sheets) {
      const row = read();
      if (!row || !(sheets > 0)) return null;
      const remaining = Math.max(0, row.remaining - sheets);
      let level = row.alert_level;
      let alert = null;
      if (remaining === 0 && level < 2) {
        level = 2;
        alert = "empty";
      } else if (level < 1 && remaining < (row.loaded * alertPercent) / 100) {
        level = 1;
        alert = "low";
      }
      db.prepare("UPDATE paper_tray SET remaining = ?, alert_level = ? WHERE id = 1").run(remaining, level);
      return alert;
    }
  };
}
