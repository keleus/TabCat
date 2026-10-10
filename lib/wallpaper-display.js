// Keep the displayed image alive until its replacement has decoded. Only the
// latest request may commit, including when the user switches back to an old image.
export function createWallpaperDisplay({ apply, fallback, createImage = () => new Image(), timeout = 8000 }) {
  let current = '', requested = '', revision = 0, pending;
  return {
    get current() { return current; },
    show(source) {
      source ||= current || fallback;
      if (requested === source) return pending;
      requested = source;
      const request = ++revision;
      if (source === current) return (pending = Promise.resolve());
      pending = (async () => {
        const image = createImage();
        let timer;
        try {
          image.src = source;
          await Promise.race([
            image.decode(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Image timeout')), timeout); }),
          ]);
          if (request === revision) { apply(source, image); current = source; }
        } catch {
          // Leave the previous image in place on a failed or timed-out download.
          if (request === revision) {
            requested = '';
            if (!current && source !== fallback) await this.show(fallback);
          }
        } finally { clearTimeout(timer); }
      })();
      return pending;
    },
  };
}
