/*
 * WASM matching kernel: successive shortest paths + Dijkstra, matching the
 * JavaScript reference in exact_cover_kernel.mjs.
 *
 * Packed graph ABI (little-endian), defined in match_protocol.mjs:
 *   u32 n
 *   for x in 0..n:
 *     u32 degree
 *     for each edge: u32 y, u32 piece, f64 cost
 *
 * Exports (wasm32):
 *   match(graph, labelsA, labelsB, destOf, totalCost) -> 1 feasible, 0 infeasible, -1 error
 *   wasm_match() uses the static buffers below
 *   wasm_graph / wasm_graph_cap / wasm_labelsA / wasm_labelsB / wasm_destOf / wasm_totalCost
 *
 * Compile (Docker):
 *   node solvers/dual_cube/build_wasm.mjs
 */
#include <stdint.h>

#define MAX_N 4096
#define MAX_V (2 + 2 * MAX_N)
#define MAX_EDGES 300000
#define MAX_HEAP 262144
#define GRAPH_CAP (4 * 1024 * 1024)

typedef struct {
  int32_t to;
  int32_t rev;
  int32_t cap;
  int32_t original;
  int32_t piece;
  int32_t source;
  double cost;
} Edge;

typedef struct {
  double d;
  int32_t u;
} HeapItem;

static uint8_t graph_storage[GRAPH_CAP];
static uint8_t labelsA_storage[MAX_N];
static uint8_t labelsB_storage[MAX_N];
static int32_t destOf_storage[MAX_N];
static double totalCost_storage;

static Edge pool[MAX_EDGES];
static int32_t adj_head[MAX_V];
static int32_t adj_next[MAX_EDGES];
static int32_t nedges;

static double pot[MAX_V];
static double dist[MAX_V];
static int32_t prevV[MAX_V];
static int32_t prevE[MAX_V];
static HeapItem heap[MAX_HEAP];
static int32_t heap_n;

static void copy_bytes(void *dst, const void *src, int n) {
  uint8_t *d = (uint8_t *)dst;
  const uint8_t *s = (const uint8_t *)src;
  for (int i = 0; i < n; i++) d[i] = s[i];
}

static uint32_t ru32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static double rf64(const uint8_t *p) {
  double v;
  copy_bytes(&v, p, 8);
  return v;
}

static void heap_push(double d, int32_t u) {
  if (heap_n >= MAX_HEAP) return;
  int i = heap_n++;
  HeapItem item;
  item.d = d;
  item.u = u;
  while (i > 0) {
    int p = (i - 1) >> 1;
    if (heap[p].d <= item.d) break;
    heap[i] = heap[p];
    i = p;
  }
  heap[i] = item;
}

static HeapItem heap_pop(void) {
  HeapItem root = heap[0];
  HeapItem last = heap[--heap_n];
  if (heap_n == 0) return root;
  int i = 0;
  heap[0] = last;
  for (;;) {
    int l = i * 2 + 1;
    int r = l + 1;
    int b = i;
    if (l < heap_n && heap[l].d < heap[b].d) b = l;
    if (r < heap_n && heap[r].d < heap[b].d) b = r;
    if (b == i) break;
    HeapItem tmp = heap[i];
    heap[i] = heap[b];
    heap[b] = tmp;
    i = b;
  }
  return root;
}

static int add_edge(int u, int v, int cap, double cost, int piece, int source) {
  if (nedges + 2 > MAX_EDGES) return 0;
  int i = nedges++;
  int j = nedges++;
  pool[i].to = v;
  pool[i].rev = j;
  pool[i].cap = cap;
  pool[i].original = cap;
  pool[i].piece = piece;
  pool[i].source = source;
  pool[i].cost = cost;
  pool[j].to = u;
  pool[j].rev = i;
  pool[j].cap = 0;
  pool[j].original = 0;
  pool[j].piece = -1;
  pool[j].source = -1;
  pool[j].cost = -cost;
  adj_next[i] = adj_head[u];
  adj_head[u] = i;
  adj_next[j] = adj_head[v];
  adj_head[v] = j;
  return 1;
}

__attribute__((export_name("wasm_graph")))
uint8_t *wasm_graph(void) { return graph_storage; }

__attribute__((export_name("wasm_graph_cap")))
int32_t wasm_graph_cap(void) { return GRAPH_CAP; }

__attribute__((export_name("wasm_labelsA")))
uint8_t *wasm_labelsA(void) { return labelsA_storage; }

__attribute__((export_name("wasm_labelsB")))
uint8_t *wasm_labelsB(void) { return labelsB_storage; }

__attribute__((export_name("wasm_destOf")))
int32_t *wasm_destOf(void) { return destOf_storage; }

__attribute__((export_name("wasm_totalCost")))
double *wasm_totalCost(void) { return &totalCost_storage; }

__attribute__((export_name("match")))
int match(const uint8_t *graph, uint8_t *labelsA, uint8_t *labelsB,
          int32_t *destOf, double *totalCost) {
  if (!graph || !labelsA || !labelsB || !destOf || !totalCost) return -1;
  uint32_t n = ru32(graph);
  if (n == 0 || n > MAX_N) return -1;
  int V = 2 + (int)n + (int)n;
  int S = 2 * (int)n;
  int T = 2 * (int)n + 1;
  nedges = 0;
  for (int v = 0; v < V; v++) adj_head[v] = -1;

  const uint8_t *p = graph + 4;
  for (uint32_t x = 0; x < n; x++) {
    if (!add_edge(S, (int)x, 1, 0.0, -1, -1)) return -1;
    uint32_t deg = ru32(p);
    p += 4;
    for (uint32_t i = 0; i < deg; i++) {
      uint32_t y = ru32(p);
      uint32_t piece = ru32(p + 4);
      double cost = rf64(p + 8);
      p += 16;
      if (y >= n) return -1;
      if (!add_edge((int)x, (int)n + (int)y, 1, cost, (int)piece, (int)x)) return -1;
    }
  }
  for (uint32_t y = 0; y < n; y++) {
    if (!add_edge((int)n + (int)y, T, 1, 0.0, -1, -1)) return -1;
  }

  for (int v = 0; v < V; v++) pot[v] = 0.0;
  int flow = 0;
  double acc = 0.0;
  while (flow < (int)n) {
    for (int v = 0; v < V; v++) {
      dist[v] = 1.0 / 0.0;
      prevV[v] = -1;
      prevE[v] = -1;
    }
    dist[S] = 0.0;
    heap_n = 0;
    heap_push(0.0, S);
    while (heap_n) {
      HeapItem it = heap_pop();
      double d = it.d;
      int u = it.u;
      if (d != dist[u]) continue;
      for (int ei = adj_head[u]; ei >= 0; ei = adj_next[ei]) {
        Edge *e = &pool[ei];
        if (e->cap <= 0) continue;
        double nd = d + e->cost + pot[u] - pot[e->to];
        if (nd + 1e-12 < dist[e->to]) {
          dist[e->to] = nd;
          prevV[e->to] = u;
          prevE[e->to] = ei;
          heap_push(nd, e->to);
        }
      }
    }
    if (dist[T] > 1e300) return 0;
    for (int v = 0; v < V; v++) {
      if (dist[v] < 1e300) pot[v] += dist[v];
    }
    int v = T;
    while (v != S) {
      int u = prevV[v];
      int ei = prevE[v];
      pool[ei].cap--;
      pool[pool[ei].rev].cap++;
      acc += pool[ei].cost;
      v = u;
    }
    flow++;
  }

  for (uint32_t i = 0; i < n; i++) {
    labelsB[i] = 255;
    destOf[i] = -1;
  }
  for (uint32_t x = 0; x < n; x++) {
    int found = 0;
    for (int ei = adj_head[x]; ei >= 0; ei = adj_next[ei]) {
      Edge *e = &pool[ei];
      if (e->to >= (int)n && e->to < 2 * (int)n && e->original == 1 && e->cap == 0 && e->piece >= 0) {
        int y = e->to - (int)n;
        labelsA[x] = (uint8_t)e->piece;
        labelsB[y] = (uint8_t)e->piece;
        destOf[x] = y;
        found = 1;
        break;
      }
    }
    if (!found) return 0;
  }
  *totalCost = acc;
  return 1;
}

__attribute__((export_name("wasm_match")))
int wasm_match(void) {
  return match(graph_storage, labelsA_storage, labelsB_storage, destOf_storage, &totalCost_storage);
}
