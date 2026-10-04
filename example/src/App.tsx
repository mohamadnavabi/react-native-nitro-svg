import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { NitroSvgView } from 'react-native-nitro-svg';

const SVG_URL = 'https://ravanshenas.net/svg-sample-transparent-large.svg';

type Status =
  | { state: 'loading' }
  | { state: 'loaded'; durationMs: number }
  | { state: 'error'; message: string };

function describeStatus(status: Status) {
  switch (status.state) {
    case 'loading':
      return 'Loading…';
    case 'loaded':
      return `Loaded in ${status.durationMs} ms`;
    case 'error':
      return `Error: ${status.message}`;
  }
}

export default function App() {
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [startedAt] = useState(() => performance.now());

  const handleLoad = useCallback(() => {
    const durationMs = Math.round(performance.now() - startedAt);
    console.log(`[NitroSvg] Loaded ${SVG_URL} in ${durationMs} ms`);
    setStatus({ state: 'loaded', durationMs });
  }, [startedAt]);

  const handleError = useCallback((message: string) => {
    console.warn(`[NitroSvg] Failed to load ${SVG_URL}: ${message}`);
    setStatus({ state: 'error', message });
  }, []);

  return (
    <View style={styles.container}>
      <NitroSvgView
        url={SVG_URL}
        width={250}
        height={250}
        cacheTime={86400}
        // eslint-disable-next-line react-native/no-inline-styles
        style={{ backgroundColor: 'transparent' }}
        onLoad={handleLoad}
        onError={handleError}
      />
      <Text style={styles.status}>{describeStatus(status)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  status: {
    marginTop: 16,
    fontSize: 14,
  },
});
