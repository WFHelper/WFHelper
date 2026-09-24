// N-API wrapper around zwlr_layer_shell_v1, the only Wayland protocol that lets
// a client choose its window's output and draw above a fullscreen game.
// Every entry point is safe on a compositor that does not implement it: they
// report unavailable rather than throwing, so the caller keeps its normal window.

#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/mman.h>
#include <poll.h>
#include <node_api.h>
#include <linux/input-event-codes.h>
#include <wayland-client.h>
#include <wayland-cursor.h>

#include "wlr-layer-shell-unstable-v1-client-protocol.h"
#include "wlr-foreign-toplevel-management-unstable-v1-client-protocol.h"
#include "xdg-output-unstable-v1-client-protocol.h"

// A compositor is another process; every wait on one is bounded because these
// calls all land on Electron's main thread.
#define ROUNDTRIP_TIMEOUT_MS 400
// The connect probe runs on the startup path, so it gets a deadline a live
// compositor beats by orders of magnitude and a wedged one cannot sit on.
#define INIT_ROUNDTRIP_TIMEOUT_MS 150
// A deadline that thin can be missed by a compositor busy with session login,
// so a timed-out probe is retried rather than costing the run the feature.
#define INIT_RETRY_COOLDOWN_MS 5000

#define MAX_OUTPUTS 16
#define MAX_SURFACES 8
#define MAX_TOPLEVELS 64
#define BUFFER_SLOTS 2
// One drain per frame at 30fps empties this many times over; a burst that
// overflows drops the oldest, which is the right loss for pointer motion.
#define MAX_EVENTS 256

enum pointer_event_type {
  EVENT_ENTER = 0,
  EVENT_LEAVE = 1,
  EVENT_MOTION = 2,
  EVENT_BUTTON = 3,
  EVENT_AXIS = 4,
};

struct pointer_event {
  int handle;
  int type;
  double x;
  double y;
  int button;
  int pressed;
  double dx;
  double dy;
};

struct output_entry {
  struct wl_output *output;
  struct zxdg_output_v1 *xdg_output;
  // Registry name, so global_remove can find the entry the compositor dropped.
  uint32_t global_id;
  char name[64];
  int scale;
  // wlroots reports wl_output.geometry at 0,0 and expects xdg-output to carry
  // the real layout, so logical_* is the only usable source for placement.
  int logical_x;
  int logical_y;
  int logical_width;
  int logical_height;
  int has_logical;
  int mode_width;
  int mode_height;
};

struct toplevel_entry {
  struct zwlr_foreign_toplevel_handle_v1 *handle;
  char title[256];
  char app_id[128];
  int activated;
  int fullscreen;
  // wl_output proxies the handle entered, resolved to names only when asked so
  // an output that disappears in between cannot be reported under a stale name.
  struct wl_output *entered[MAX_OUTPUTS];
};

struct buffer_slot {
  struct wl_buffer *buffer;
  uint8_t *pixels;
  size_t size;
  int busy;
};

struct layer_window {
  int used;
  int interactive;
  struct wl_surface *surface;
  struct zwlr_layer_surface_v1 *layer;
  // The output the surface is currently shown on, so an output scale change can
  // find the windows it applies to. NULL until the compositor says.
  struct wl_output *output;
  struct buffer_slot slots[BUFFER_SLOTS];
  int next_slot;
  int width;
  int height;
  // Buffer pixels per logical pixel. Buffers are width*scale by height*scale
  // while set_size stays logical, which is what keeps text sharp on HiDPI.
  int scale;
  // The scale the surface last committed. Buffer scale is double-buffered
  // state, so it may only be sent with the frame drawn at that density.
  int committed_scale;
  int configured;
  int closed;
};

static struct wl_display *display = NULL;
static struct wl_compositor *compositor = NULL;
static struct wl_shm *shm = NULL;
static struct zwlr_layer_shell_v1 *layer_shell = NULL;
static struct zxdg_output_manager_v1 *xdg_output_manager = NULL;
static struct zwlr_foreign_toplevel_manager_v1 *toplevel_manager = NULL;
static struct output_entry outputs[MAX_OUTPUTS];
static int output_count = 0;
static struct toplevel_entry toplevels[MAX_TOPLEVELS];
static int toplevel_count = 0;
static struct layer_window windows[MAX_SURFACES];
static int connect_attempted = 0;
static int connect_ok = 0;
// Set once the answer is final: no wayland socket, or a compositor that named
// its globals and had nothing this addon can use. Only a timeout is retried.
static int connect_latched = 0;
static long long connect_last_attempt_ms = 0;
static int init_ok = 0;
// Same finality for layer-shell alone: the registry roundtrip completed without
// it, so asking again would only repeat the answer.
static int init_latched = 0;

static struct wl_seat *seat = NULL;
static struct wl_pointer *pointer = NULL;
static struct wl_cursor_theme *cursor_theme = NULL;
static struct wl_surface *cursor_surface = NULL;
static int cursor_hotspot_x = 0;
static int cursor_hotspot_y = 0;
static struct pointer_event event_queue[MAX_EVENTS];
static int event_count = 0;
static int event_dropped = 0;
// Surface the pointer is currently over, so motion and button events know
// which overlay to route to; wayland only names the surface on enter.
static int pointer_focus = -1;
static double pointer_x = 0;
static double pointer_y = 0;

static void noop_geometry(void *d, struct wl_output *o, int32_t x, int32_t y, int32_t pw,
                          int32_t ph, int32_t sp, const char *make, const char *model, int32_t tr) {
  (void)d; (void)o; (void)x; (void)y; (void)pw; (void)ph; (void)sp; (void)make; (void)model;
  (void)tr;
}
static void on_output_mode(void *data, struct wl_output *o, uint32_t flags, int32_t w, int32_t h,
                           int32_t r) {
  (void)o; (void)r;
  struct output_entry *entry = data;
  if (!(flags & WL_OUTPUT_MODE_CURRENT)) return;
  entry->mode_width = w;
  entry->mode_height = h;
}
static void noop_done(void *d, struct wl_output *o) { (void)d; (void)o; }
static void adopt_output_scale(struct wl_output *output, int scale);

static void on_output_scale(void *data, struct wl_output *o, int32_t scale) {
  (void)o;
  struct output_entry *entry = data;
  if (scale > 0) {
    entry->scale = scale;
    adopt_output_scale(entry->output, scale);
  }
}
static void on_output_name(void *data, struct wl_output *o, const char *name) {
  (void)o;
  struct output_entry *entry = data;
  snprintf(entry->name, sizeof(entry->name), "%s", name);
}
static void noop_description(void *d, struct wl_output *o, const char *desc) {
  (void)d; (void)o; (void)desc;
}

// A live surface has to follow its output's scale, or its buffers stay at the
// old density and every later frame is sized for a scale the compositor
// dropped. resize_slots re-makes the mapping on the next commit.
static void adopt_output_scale(struct wl_output *output, int scale) {
  if (!output || scale <= 0) return;
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (!windows[i].used || windows[i].output != output) continue;
    // Recorded only. Sending set_buffer_scale here would let any bufferless
    // commit apply it to the frame still attached at the old density.
    windows[i].scale = scale;
  }
}

static void on_surface_enter(void *data, struct wl_surface *surface, struct wl_output *output) {
  (void)surface;
  struct layer_window *win = data;
  win->output = output;
  for (int i = 0; i < MAX_OUTPUTS; i++) {
    if (outputs[i].output != output || outputs[i].scale <= 0) continue;
    // Recorded only; the commit that carries a frame at this density sends it.
    win->scale = outputs[i].scale;
    return;
  }
}

static void on_surface_leave(void *data, struct wl_surface *surface, struct wl_output *output) {
  (void)surface;
  struct layer_window *win = data;
  if (win->output == output) win->output = NULL;
}

static const struct wl_surface_listener surface_listener = {
    .enter = on_surface_enter,
    .leave = on_surface_leave,
};

static const struct wl_output_listener output_listener = {
    .geometry = noop_geometry,
    .mode = on_output_mode,
    .done = noop_done,
    .scale = on_output_scale,
    .name = on_output_name,
    .description = noop_description,
};

static void push_event(const struct pointer_event *event) {
  if (event_count >= MAX_EVENTS) {
    // Drop the oldest: a stale motion is worth less than the newest one.
    memmove(&event_queue[0], &event_queue[1], sizeof(event_queue[0]) * (MAX_EVENTS - 1));
    event_count = MAX_EVENTS - 1;
    event_dropped = 1;
  }
  event_queue[event_count++] = *event;
}

static int handle_for_surface(struct wl_surface *surface) {
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (windows[i].used && windows[i].surface == surface) return i;
  }
  return -1;
}

/** Without an attached cursor buffer the pointer keeps whatever image the
 *  surface underneath set, which over a game reads as a frozen crosshair. */
static void apply_cursor(uint32_t serial) {
  if (!pointer) return;
  if (!cursor_surface) {
    if (!cursor_theme) cursor_theme = wl_cursor_theme_load(NULL, 24, shm);
    if (!cursor_theme) return;
    struct wl_cursor *cursor = wl_cursor_theme_get_cursor(cursor_theme, "left_ptr");
    if (!cursor || cursor->image_count == 0) return;
    struct wl_cursor_image *image = cursor->images[0];
    struct wl_buffer *buffer = wl_cursor_image_get_buffer(image);
    if (!buffer) return;
    cursor_surface = wl_compositor_create_surface(compositor);
    if (!cursor_surface) return;
    cursor_hotspot_x = (int)image->hotspot_x;
    cursor_hotspot_y = (int)image->hotspot_y;
    wl_surface_attach(cursor_surface, buffer, 0, 0);
    wl_surface_damage(cursor_surface, 0, 0, (int32_t)image->width, (int32_t)image->height);
    wl_surface_commit(cursor_surface);
  }
  wl_pointer_set_cursor(pointer, serial, cursor_surface, cursor_hotspot_x, cursor_hotspot_y);
}

static void on_pointer_enter(void *data, struct wl_pointer *wl_pointer, uint32_t serial,
                             struct wl_surface *surface, wl_fixed_t sx, wl_fixed_t sy) {
  (void)data; (void)wl_pointer;
  pointer_focus = handle_for_surface(surface);
  if (pointer_focus < 0) return;
  pointer_x = wl_fixed_to_double(sx);
  pointer_y = wl_fixed_to_double(sy);
  apply_cursor(serial);
  struct pointer_event event = {.handle = pointer_focus,
                               .type = EVENT_ENTER,
                               .x = pointer_x,
                               .y = pointer_y};
  push_event(&event);
}

static void on_pointer_leave(void *data, struct wl_pointer *wl_pointer, uint32_t serial,
                             struct wl_surface *surface) {
  (void)data; (void)wl_pointer; (void)serial;
  int handle = handle_for_surface(surface);
  if (handle >= 0) {
    struct pointer_event event = {
        .handle = handle, .type = EVENT_LEAVE, .x = pointer_x, .y = pointer_y};
    push_event(&event);
  }
  pointer_focus = -1;
}

static void on_pointer_motion(void *data, struct wl_pointer *wl_pointer, uint32_t time,
                              wl_fixed_t sx, wl_fixed_t sy) {
  (void)data; (void)wl_pointer; (void)time;
  if (pointer_focus < 0) return;
  pointer_x = wl_fixed_to_double(sx);
  pointer_y = wl_fixed_to_double(sy);
  struct pointer_event event = {
      .handle = pointer_focus, .type = EVENT_MOTION, .x = pointer_x, .y = pointer_y};
  push_event(&event);
}

static void on_pointer_button(void *data, struct wl_pointer *wl_pointer, uint32_t serial,
                              uint32_t time, uint32_t button, uint32_t state) {
  (void)data; (void)wl_pointer; (void)serial; (void)time;
  if (pointer_focus < 0) return;
  int mapped;
  if (button == BTN_LEFT) mapped = 0;
  else if (button == BTN_MIDDLE) mapped = 1;
  else if (button == BTN_RIGHT) mapped = 2;
  else return;
  struct pointer_event event = {.handle = pointer_focus,
                               .type = EVENT_BUTTON,
                               .x = pointer_x,
                               .y = pointer_y,
                               .button = mapped,
                               .pressed = state == WL_POINTER_BUTTON_STATE_PRESSED};
  push_event(&event);
}

static void on_pointer_axis(void *data, struct wl_pointer *wl_pointer, uint32_t time,
                            uint32_t axis, wl_fixed_t value) {
  (void)data; (void)wl_pointer; (void)time;
  if (pointer_focus < 0) return;
  double amount = wl_fixed_to_double(value);
  struct pointer_event event = {.handle = pointer_focus,
                               .type = EVENT_AXIS,
                               .x = pointer_x,
                               .y = pointer_y,
                               .dx = axis == WL_POINTER_AXIS_HORIZONTAL_SCROLL ? amount : 0,
                               .dy = axis == WL_POINTER_AXIS_VERTICAL_SCROLL ? amount : 0};
  push_event(&event);
}

static void noop_pointer_frame(void *d, struct wl_pointer *p) { (void)d; (void)p; }
static void noop_axis_source(void *d, struct wl_pointer *p, uint32_t s) { (void)d; (void)p; (void)s; }
static void noop_axis_stop(void *d, struct wl_pointer *p, uint32_t t, uint32_t a) {
  (void)d; (void)p; (void)t; (void)a;
}
static void noop_axis_discrete(void *d, struct wl_pointer *p, uint32_t a, int32_t v) {
  (void)d; (void)p; (void)a; (void)v;
}

static const struct wl_pointer_listener pointer_listener = {
    .enter = on_pointer_enter,
    .leave = on_pointer_leave,
    .motion = on_pointer_motion,
    .button = on_pointer_button,
    .axis = on_pointer_axis,
    .frame = noop_pointer_frame,
    .axis_source = noop_axis_source,
    .axis_stop = noop_axis_stop,
    .axis_discrete = noop_axis_discrete,
};

static void on_seat_capabilities(void *data, struct wl_seat *wl_seat, uint32_t capabilities) {
  (void)data;
  if ((capabilities & WL_SEAT_CAPABILITY_POINTER) && !pointer) {
    pointer = wl_seat_get_pointer(wl_seat);
    wl_pointer_add_listener(pointer, &pointer_listener, NULL);
  } else if (!(capabilities & WL_SEAT_CAPABILITY_POINTER)) {
    // The proxy is kept on purpose. Unplugging a mouse drops the capability and
    // re-adding it raises a fresh event, and holding the proxy means a missed
    // re-add cannot leave the overlays permanently deaf to clicks.
    pointer_focus = -1;
  }
}

static void noop_seat_name(void *d, struct wl_seat *s, const char *name) {
  (void)d; (void)s; (void)name;
}

static const struct wl_seat_listener seat_listener = {
    .capabilities = on_seat_capabilities,
    .name = noop_seat_name,
};

static void on_xdg_logical_position(void *data, struct zxdg_output_v1 *o, int32_t x, int32_t y) {
  (void)o;
  struct output_entry *entry = data;
  entry->logical_x = x;
  entry->logical_y = y;
  entry->has_logical = 1;
}

static void on_xdg_logical_size(void *data, struct zxdg_output_v1 *o, int32_t w, int32_t h) {
  (void)o;
  struct output_entry *entry = data;
  if (w > 0) entry->logical_width = w;
  if (h > 0) entry->logical_height = h;
}

static void noop_xdg_done(void *d, struct zxdg_output_v1 *o) { (void)d; (void)o; }
static void noop_xdg_name(void *d, struct zxdg_output_v1 *o, const char *n) {
  (void)d; (void)o; (void)n;
}
static void noop_xdg_desc(void *d, struct zxdg_output_v1 *o, const char *n) {
  (void)d; (void)o; (void)n;
}

static const struct zxdg_output_v1_listener xdg_output_listener = {
    .logical_position = on_xdg_logical_position,
    .logical_size = on_xdg_logical_size,
    .done = noop_xdg_done,
    .name = noop_xdg_name,
    .description = noop_xdg_desc,
};

static void on_toplevel_title(void *data, struct zwlr_foreign_toplevel_handle_v1 *h,
                              const char *title) {
  (void)h;
  struct toplevel_entry *entry = data;
  snprintf(entry->title, sizeof(entry->title), "%s", title);
}

static void on_toplevel_app_id(void *data, struct zwlr_foreign_toplevel_handle_v1 *h,
                               const char *app_id) {
  (void)h;
  struct toplevel_entry *entry = data;
  snprintf(entry->app_id, sizeof(entry->app_id), "%s", app_id);
}

static void on_toplevel_output_enter(void *data, struct zwlr_foreign_toplevel_handle_v1 *h,
                                     struct wl_output *output) {
  (void)h;
  struct toplevel_entry *entry = data;
  int free_slot = -1;
  for (int i = 0; i < MAX_OUTPUTS; i++) {
    if (entry->entered[i] == output) return;
    if (!entry->entered[i] && free_slot < 0) free_slot = i;
  }
  if (free_slot >= 0) entry->entered[free_slot] = output;
}

static void on_toplevel_output_leave(void *data, struct zwlr_foreign_toplevel_handle_v1 *h,
                                     struct wl_output *output) {
  (void)h;
  struct toplevel_entry *entry = data;
  for (int i = 0; i < MAX_OUTPUTS; i++) {
    if (entry->entered[i] == output) entry->entered[i] = NULL;
  }
}

// The compositor sends the complete state set every time, so the flags are
// rebuilt from the array rather than toggled.
static void on_toplevel_state(void *data, struct zwlr_foreign_toplevel_handle_v1 *h,
                              struct wl_array *state) {
  (void)h;
  struct toplevel_entry *entry = data;
  entry->activated = 0;
  entry->fullscreen = 0;
  uint32_t *value;
  wl_array_for_each(value, state) {
    if (*value == ZWLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_ACTIVATED) entry->activated = 1;
    else if (*value == ZWLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_FULLSCREEN) entry->fullscreen = 1;
  }
}

static void noop_toplevel_done(void *d, struct zwlr_foreign_toplevel_handle_v1 *h) {
  (void)d; (void)h;
}

static void on_toplevel_closed(void *data, struct zwlr_foreign_toplevel_handle_v1 *h) {
  struct toplevel_entry *entry = data;
  zwlr_foreign_toplevel_handle_v1_destroy(h);
  memset(entry, 0, sizeof(*entry));
}

static void noop_toplevel_parent(void *d, struct zwlr_foreign_toplevel_handle_v1 *h,
                                 struct zwlr_foreign_toplevel_handle_v1 *parent) {
  (void)d; (void)h; (void)parent;
}

static const struct zwlr_foreign_toplevel_handle_v1_listener toplevel_handle_listener = {
    .title = on_toplevel_title,
    .app_id = on_toplevel_app_id,
    .output_enter = on_toplevel_output_enter,
    .output_leave = on_toplevel_output_leave,
    .state = on_toplevel_state,
    .done = noop_toplevel_done,
    .closed = on_toplevel_closed,
    .parent = noop_toplevel_parent,
};

static void on_toplevel(void *data, struct zwlr_foreign_toplevel_manager_v1 *manager,
                        struct zwlr_foreign_toplevel_handle_v1 *handle) {
  (void)data; (void)manager;
  // Every handle listener holds a pointer to its own slot, so entries are never
  // moved or compacted, and a slot is reused only once its handle is destroyed.
  struct toplevel_entry *entry = NULL;
  for (int i = 0; i < toplevel_count; i++) {
    if (!toplevels[i].handle) {
      entry = &toplevels[i];
      break;
    }
  }
  if (!entry && toplevel_count < MAX_TOPLEVELS) entry = &toplevels[toplevel_count++];
  if (!entry) {
    zwlr_foreign_toplevel_handle_v1_destroy(handle);
    return;
  }
  memset(entry, 0, sizeof(*entry));
  entry->handle = handle;
  zwlr_foreign_toplevel_handle_v1_add_listener(handle, &toplevel_handle_listener, entry);
}

// live=0 frees the handle proxies without a destroy request: after the manager's
// finished event, whose effect on the handles the protocol does not state, and
// on a display already in error.
static void clear_toplevels(int live) {
  for (int i = 0; i < toplevel_count; i++) {
    if (!toplevels[i].handle) continue;
    if (live) zwlr_foreign_toplevel_handle_v1_destroy(toplevels[i].handle);
    else wl_proxy_destroy((struct wl_proxy *)toplevels[i].handle);
  }
  memset(toplevels, 0, sizeof(toplevels));
  toplevel_count = 0;
}

static void on_toplevel_manager_finished(void *data,
                                         struct zwlr_foreign_toplevel_manager_v1 *manager) {
  (void)data;
  clear_toplevels(0);
  // Generated as a plain wl_proxy_destroy, so this sends nothing either.
  zwlr_foreign_toplevel_manager_v1_destroy(manager);
  toplevel_manager = NULL;
}

static const struct zwlr_foreign_toplevel_manager_v1_listener toplevel_manager_listener = {
    .toplevel = on_toplevel,
    .finished = on_toplevel_manager_finished,
};

static void on_global(void *data, struct wl_registry *registry, uint32_t id, const char *interface,
                      uint32_t version) {
  (void)data;
  if (strcmp(interface, wl_compositor_interface.name) == 0) {
    compositor = wl_registry_bind(registry, id, &wl_compositor_interface, 4);
  } else if (strcmp(interface, wl_shm_interface.name) == 0) {
    shm = wl_registry_bind(registry, id, &wl_shm_interface, 1);
  } else if (strcmp(interface, zwlr_layer_shell_v1_interface.name) == 0) {
    uint32_t want = version < 4 ? version : 4;
    layer_shell = wl_registry_bind(registry, id, &zwlr_layer_shell_v1_interface, want);
  } else if (strcmp(interface, zwlr_foreign_toplevel_manager_v1_interface.name) == 0 &&
             !toplevel_manager) {
    uint32_t want = version < 3 ? version : 3;
    toplevel_manager =
        wl_registry_bind(registry, id, &zwlr_foreign_toplevel_manager_v1_interface, want);
    zwlr_foreign_toplevel_manager_v1_add_listener(toplevel_manager, &toplevel_manager_listener,
                                                  NULL);
  } else if (strcmp(interface, zxdg_output_manager_v1_interface.name) == 0 &&
             !xdg_output_manager) {
    uint32_t want = version < 3 ? version : 3;
    xdg_output_manager = wl_registry_bind(registry, id, &zxdg_output_manager_v1_interface, want);
  } else if (strcmp(interface, wl_seat_interface.name) == 0 && !seat) {
    uint32_t want = version < 5 ? version : 5;
    seat = wl_registry_bind(registry, id, &wl_seat_interface, want);
    wl_seat_add_listener(seat, &seat_listener, NULL);
  } else if (strcmp(interface, wl_output_interface.name) == 0 && version >= 4) {
    // Slots are reused rather than compacted: every wl_output listener holds a
    // pointer to its own slot, so moving an entry would strand one.
    struct output_entry *entry = NULL;
    for (int i = 0; i < output_count; i++) {
      if (!outputs[i].output) {
        entry = &outputs[i];
        break;
      }
    }
    if (!entry && output_count < MAX_OUTPUTS) entry = &outputs[output_count++];
    if (!entry) return;
    memset(entry, 0, sizeof(*entry));
    entry->global_id = id;
    entry->output = wl_registry_bind(registry, id, &wl_output_interface, 4);
    wl_output_add_listener(entry->output, &output_listener, entry);
    // A monitor plugged in mid-session needs its logical geometry too, and only
    // xdg-output reports it; ensure_init's pass covers the first batch alone.
    if (xdg_output_manager) {
      entry->xdg_output = zxdg_output_manager_v1_get_xdg_output(xdg_output_manager, entry->output);
      zxdg_output_v1_add_listener(entry->xdg_output, &xdg_output_listener, entry);
    }
  }
}

static void on_global_remove(void *d, struct wl_registry *r, uint32_t id) {
  (void)d; (void)r;
  for (int i = 0; i < output_count; i++) {
    struct output_entry *entry = &outputs[i];
    if (!entry->output || entry->global_id != id) continue;
    // A window holds this pointer to match later scale changes, and binding a
    // fresh global can return the same address, so it goes with the output.
    for (int w = 0; w < MAX_SURFACES; w++) {
      if (windows[w].used && windows[w].output == entry->output) windows[w].output = NULL;
    }
    for (int t = 0; t < toplevel_count; t++) {
      for (int o = 0; o < MAX_OUTPUTS; o++) {
        if (toplevels[t].entered[o] == entry->output) toplevels[t].entered[o] = NULL;
      }
    }
    // The proxy dies with the global. Handing a stale one to get_layer_surface
    // is a fatal protocol error, which would latch layer-shell off for good.
    if (entry->xdg_output) zxdg_output_v1_destroy(entry->xdg_output);
    wl_output_release(entry->output);
    memset(entry, 0, sizeof(*entry));
    return;
  }
}

static const struct wl_registry_listener registry_listener = {
    .global = on_global,
    .global_remove = on_global_remove,
};

static void on_sync_done(void *data, struct wl_callback *callback, uint32_t serial) {
  (void)serial;
  (void)callback;
  *(int *)data = 1;
}

static const struct wl_callback_listener sync_listener = {.done = on_sync_done};

/** wl_display_roundtrip with a deadline. The blocking form waits forever, and a
 *  compositor that stops answering would take Electron's main thread with it. */
static int roundtrip_timeout(int timeout_ms) {
  if (!display) return 0;
  // done lives on this frame, which is safe because the callback is destroyed
  // before returning, so the listener cannot fire against a dead pointer.
  int done = 0;
  struct wl_callback *callback = wl_display_sync(display);
  if (!callback) return 0;
  wl_callback_add_listener(callback, &sync_listener, &done);

  const int fd = wl_display_get_fd(display);
  int remaining = timeout_ms;
  while (!done) {
    while (wl_display_prepare_read(display) != 0) {
      if (wl_display_dispatch_pending(display) < 0) goto finish;
    }
    if (wl_display_flush(display) < 0 && errno != EAGAIN) {
      wl_display_cancel_read(display);
      goto finish;
    }
    if (done) {
      wl_display_cancel_read(display);
      break;
    }
    struct pollfd pfd = {.fd = fd, .events = POLLIN, .revents = 0};
    struct timespec before, after;
    clock_gettime(CLOCK_MONOTONIC, &before);
    if (poll(&pfd, 1, remaining) <= 0) {
      wl_display_cancel_read(display);
      goto finish;
    }
    if (wl_display_read_events(display) < 0) goto finish;
    if (wl_display_dispatch_pending(display) < 0) goto finish;
    clock_gettime(CLOCK_MONOTONIC, &after);
    long elapsed = (after.tv_sec - before.tv_sec) * 1000 +
                   (after.tv_nsec - before.tv_nsec) / 1000000;
    remaining -= (int)(elapsed > 0 ? elapsed : 1);
    if (remaining <= 0) goto finish;
  }

finish:;
  wl_callback_destroy(callback);
  return done;
}

static long long monotonic_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

/** Undoes a connect so a retry starts from nothing. Callers reached from a live
 *  init must clear the window table first, which drop_connection does: the
 *  surfaces die with the display and their handles must not outlive it. */
static void reset_connection(void) {
  clear_toplevels(1);
  for (int i = 0; i < output_count; i++) {
    if (outputs[i].xdg_output) zxdg_output_v1_destroy(outputs[i].xdg_output);
    if (outputs[i].output) wl_output_release(outputs[i].output);
  }
  memset(outputs, 0, sizeof(outputs));
  output_count = 0;
  if (cursor_theme) wl_cursor_theme_destroy(cursor_theme);
  cursor_theme = NULL;
  cursor_surface = NULL;
  // Disconnecting destroys every remaining proxy, so the rest only need nulling.
  if (display) wl_display_disconnect(display);
  display = NULL;
  compositor = NULL;
  shm = NULL;
  layer_shell = NULL;
  xdg_output_manager = NULL;
  toplevel_manager = NULL;
  seat = NULL;
  pointer = NULL;
  connect_ok = 0;
}

/** Connect and bind the globals. Separate from ensure_init because toplevel
 *  tracking needs the display alone, so a compositor without layer-shell must
 *  not take the connection down with the layer-shell answer. */
static int ensure_connection(void) {
  if (connect_ok) return 1;
  if (connect_latched) return 0;
  const long long now = monotonic_ms();
  if (connect_attempted && now - connect_last_attempt_ms < INIT_RETRY_COOLDOWN_MS) return 0;
  connect_attempted = 1;
  connect_last_attempt_ms = now;
  display = wl_display_connect(NULL);
  // No socket means no wayland session, and one does not appear mid-run.
  if (!display) {
    connect_latched = 1;
    return 0;
  }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  // A timed-out roundtrip says nothing about the compositor, so drop what was
  // half-bound and let the next call ask again.
  if (!roundtrip_timeout(INIT_ROUNDTRIP_TIMEOUT_MS)) {
    reset_connection();
    return 0;
  }
  // An xdg-output can only be made once the manager and the outputs are both
  // bound, so it needs the second pass to deliver its geometry.
  if (xdg_output_manager) {
    for (int i = 0; i < output_count; i++) {
      if (!outputs[i].output || outputs[i].xdg_output) continue;
      outputs[i].xdg_output =
          zxdg_output_manager_v1_get_xdg_output(xdg_output_manager, outputs[i].output);
      zxdg_output_v1_add_listener(outputs[i].xdg_output, &xdg_output_listener, &outputs[i]);
    }
  }
  // Second pass so the per-output name, logical geometry and the first batch of
  // toplevel events land.
  roundtrip_timeout(INIT_ROUNDTRIP_TIMEOUT_MS);
  connect_ok = 1;
  return 1;
}

static int ensure_init(void) {
  if (init_ok) return 1;
  if (init_latched) return 0;
  if (!ensure_connection()) return 0;
  init_ok = compositor && shm && layer_shell;
  if (!init_ok) {
    init_latched = 1;
    // Nothing else here uses the connection once layer-shell is out, unless
    // toplevel tracking does.
    if (!toplevel_manager) {
      reset_connection();
      connect_latched = 1;
    }
  }
  return init_ok;
}

/** Non-blocking read plus dispatch. dispatch_pending alone only drains events
 *  already read off the socket, so buffer releases would never arrive and both
 *  shm slots would stay busy after the second frame. */
static void pump_events(void) {
  if (!display) return;
  while (wl_display_prepare_read(display) != 0) {
    // A broken connection fails prepare_read forever. This runs on Electron's
    // main thread, so a failed dispatch has to end the loop, not spin on it.
    if (wl_display_dispatch_pending(display) < 0) return;
  }
  wl_display_flush(display);
  struct pollfd pfd = {.fd = wl_display_get_fd(display), .events = POLLIN, .revents = 0};
  if (poll(&pfd, 1, 0) > 0 && (pfd.revents & POLLIN)) {
    wl_display_read_events(display);
  } else {
    wl_display_cancel_read(display);
  }
  wl_display_dispatch_pending(display);
}

static void on_layer_configure(void *data, struct zwlr_layer_surface_v1 *layer, uint32_t serial,
                               uint32_t width, uint32_t height) {
  struct layer_window *win = data;
  if (width > 0) win->width = (int)width;
  if (height > 0) win->height = (int)height;
  zwlr_layer_surface_v1_ack_configure(layer, serial);
  win->configured = 1;
}

static void on_layer_closed(void *data, struct zwlr_layer_surface_v1 *layer) {
  (void)layer;
  struct layer_window *win = data;
  win->closed = 1;
}

static const struct zwlr_layer_surface_v1_listener layer_listener = {
    .configure = on_layer_configure,
    .closed = on_layer_closed,
};

static void on_buffer_release(void *data, struct wl_buffer *buffer) {
  (void)buffer;
  struct buffer_slot *slot = data;
  slot->busy = 0;
}

static const struct wl_buffer_listener buffer_listener = {.release = on_buffer_release};

static int alloc_slot(struct buffer_slot *slot, int width, int height) {
  size_t size = (size_t)width * (size_t)height * 4;
  int fd = memfd_create("wfhelper-layer", MFD_CLOEXEC);
  if (fd < 0) return 0;
  if (ftruncate(fd, (off_t)size) < 0) {
    close(fd);
    return 0;
  }
  void *pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (pixels == MAP_FAILED) {
    close(fd);
    return 0;
  }
  struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, (int32_t)size);
  slot->buffer = wl_shm_pool_create_buffer(pool, 0, width, height, width * 4,
                                           WL_SHM_FORMAT_ARGB8888);
  wl_shm_pool_destroy(pool);
  close(fd);
  if (!slot->buffer) {
    munmap(pixels, size);
    return 0;
  }
  slot->pixels = pixels;
  slot->size = size;
  slot->busy = 0;
  wl_buffer_add_listener(slot->buffer, &buffer_listener, slot);
  return 1;
}

static void free_slot(struct buffer_slot *slot) {
  if (slot->buffer) wl_buffer_destroy(slot->buffer);
  if (slot->pixels) munmap(slot->pixels, slot->size);
  memset(slot, 0, sizeof(*slot));
}

// Re-makes both slots at the window's current pixel size, or leaves them alone
// when they already match. Keyed on the mapping rather than on any requested
// size, because the compositor can configure a size the client already asked
// for and a dimension comparison would then skip a reallocation that is due.
static int resize_slots(struct layer_window *win) {
  const int pixel_width = win->width * win->scale;
  const int pixel_height = win->height * win->scale;
  const size_t needed = (size_t)pixel_width * (size_t)pixel_height * 4;
  int stale = 0;
  for (int i = 0; i < BUFFER_SLOTS; i++) {
    if (win->slots[i].size != needed) stale = 1;
  }
  if (!stale) return 1;

  for (int i = 0; i < BUFFER_SLOTS; i++) free_slot(&win->slots[i]);
  for (int i = 0; i < BUFFER_SLOTS; i++) {
    if (alloc_slot(&win->slots[i], pixel_width, pixel_height)) continue;
    for (int j = 0; j < i; j++) free_slot(&win->slots[j]);
    // With no buffers no frame can ever land again, so report the surface as
    // gone and let the caller build a fresh one.
    win->closed = 1;
    return 0;
  }
  return 1;
}

static napi_value Available(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_get_boolean(env, ensure_init() ? true : false, &out);
  return out;
}

static napi_value Outputs(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value list;
  napi_create_array(env, &list);
  if (!ensure_init()) return list;
  uint32_t index = 0;
  for (int i = 0; i < output_count; i++) {
    if (!outputs[i].output) continue;
    napi_value name;
    napi_create_string_utf8(env, outputs[i].name, NAPI_AUTO_LENGTH, &name);
    napi_set_element(env, list, index++, name);
  }
  return list;
}

/** Drops everything after a fatal display error, so the next call reconnects
 *  instead of answering from a table that can no longer change. Overlays go
 *  with it: isClosed() then reports them gone and the caller rebuilds them. */
static void drop_connection(void) {
  // The handles cannot take a destructor request once the display is in error.
  clear_toplevels(0);
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (!windows[i].used) continue;
    for (int s = 0; s < BUFFER_SLOTS; s++) free_slot(&windows[i].slots[s]);
    memset(&windows[i], 0, sizeof(windows[i]));
  }
  pointer_focus = -1;
  event_count = 0;
  event_dropped = 0;
  init_ok = 0;
  // Not latched: a fresh compositor may well have layer-shell. The cooldown is
  // restarted so a wedged socket cannot be reconnected once per poll.
  init_latched = 0;
  reset_connection();
  connect_last_attempt_ms = monotonic_ms();
}

// toplevels() -> [{title, appId, activated, fullscreen, outputs}], or null where
// zwlr_foreign_toplevel_manager_v1 is missing. Only the connect blocks: up to two
// INIT_ROUNDTRIP_TIMEOUT_MS roundtrips on the first call, then at most once per
// INIT_RETRY_COOLDOWN_MS after a failure.
static napi_value Toplevels(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value list;
  // Deliberately not ensure_init: a compositor with no layer-shell can still
  // answer this, and Available() staying false must not disable it.
  if (!ensure_connection() || !toplevel_manager) {
    napi_get_null(env, &list);
    return list;
  }
  pump_events();
  // A dead connection keeps the table forever at its last state, which would
  // read as a real answer and stop the caller falling back to X11.
  if (wl_display_get_error(display) != 0) {
    drop_connection();
    napi_get_null(env, &list);
    return list;
  }

  napi_create_array(env, &list);
  uint32_t index = 0;
  for (int i = 0; i < toplevel_count; i++) {
    const struct toplevel_entry *entry = &toplevels[i];
    if (!entry->handle) continue;
    napi_value item, value;
    napi_create_object(env, &item);
    napi_create_string_utf8(env, entry->title, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "title", value);
    napi_create_string_utf8(env, entry->app_id, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, item, "appId", value);
    napi_get_boolean(env, entry->activated ? true : false, &value);
    napi_set_named_property(env, item, "activated", value);
    napi_get_boolean(env, entry->fullscreen ? true : false, &value);
    napi_set_named_property(env, item, "fullscreen", value);

    napi_value names;
    napi_create_array(env, &names);
    uint32_t named = 0;
    for (int o = 0; o < MAX_OUTPUTS; o++) {
      if (!entry->entered[o]) continue;
      for (int s = 0; s < output_count; s++) {
        if (!outputs[s].output || outputs[s].output != entry->entered[o]) continue;
        napi_value name;
        napi_create_string_utf8(env, outputs[s].name, NAPI_AUTO_LENGTH, &name);
        napi_set_element(env, names, named++, name);
        break;
      }
    }
    napi_set_named_property(env, item, "outputs", names);
    napi_set_element(env, list, index++, item);
  }
  return list;
}

// create(outputName|null, width, height, anchor, marginTop, marginRight,
//        marginBottom, marginLeft) -> handle, or -1
static napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 8;
  napi_value argv[8];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value failed;
  napi_create_int32(env, -1, &failed);
  if (argc < 3 || !ensure_init()) return failed;

  char wanted[64] = {0};
  napi_valuetype type;
  napi_typeof(env, argv[0], &type);
  if (type == napi_string) {
    size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], wanted, sizeof(wanted), &len);
  }

  int32_t width = 0, height = 0, anchor = 0, mt = 0, mr = 0, mb = 0, ml = 0;
  napi_get_value_int32(env, argv[1], &width);
  napi_get_value_int32(env, argv[2], &height);
  if (argc > 3) napi_get_value_int32(env, argv[3], &anchor);
  if (argc > 4) napi_get_value_int32(env, argv[4], &mt);
  if (argc > 5) napi_get_value_int32(env, argv[5], &mr);
  if (argc > 6) napi_get_value_int32(env, argv[6], &mb);
  if (argc > 7) napi_get_value_int32(env, argv[7], &ml);
  if (width <= 0 || height <= 0) return failed;

  struct wl_output *target = NULL;
  int scale = 1;
  if (wanted[0]) {
    for (int i = 0; i < output_count; i++) {
      if (!outputs[i].output) continue;
      if (strcmp(outputs[i].name, wanted) == 0) {
        target = outputs[i].output;
        scale = outputs[i].scale > 0 ? outputs[i].scale : 1;
        break;
      }
    }
    // A named output that is gone is an error, not a silent move elsewhere.
    if (!target) return failed;
  } else {
    // The compositor picks the output, so size for the sharpest one it could
    // pick. An over-scaled buffer still maps to the right logical size.
    for (int i = 0; i < output_count; i++) {
      if (outputs[i].output && outputs[i].scale > scale) scale = outputs[i].scale;
    }
  }

  int handle = -1;
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (!windows[i].used) {
      handle = i;
      break;
    }
  }
  if (handle < 0) return failed;

  struct layer_window *win = &windows[handle];
  memset(win, 0, sizeof(*win));
  win->used = 1;
  win->width = width;
  win->height = height;
  win->scale = scale;

  win->surface = wl_compositor_create_surface(compositor);
  // The listener is what lets a later scale change on this surface's output
  // reach this window.
  wl_surface_add_listener(win->surface, &surface_listener, win);
  win->layer = zwlr_layer_shell_v1_get_layer_surface(
      layer_shell, win->surface, target, ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY, "wfhelper");
  zwlr_layer_surface_v1_add_listener(win->layer, &layer_listener, win);
  zwlr_layer_surface_v1_set_size(win->layer, (uint32_t)width, (uint32_t)height);
  zwlr_layer_surface_v1_set_anchor(win->layer, (uint32_t)anchor);
  zwlr_layer_surface_v1_set_margin(win->layer, mt, mr, mb, ml);
  // -1 so the overlay never reserves space and shoves tiled windows aside.
  zwlr_layer_surface_v1_set_exclusive_zone(win->layer, -1);
  zwlr_layer_surface_v1_set_keyboard_interactivity(
      win->layer, ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);

  wl_surface_set_buffer_scale(win->surface, scale);
  win->committed_scale = scale;

  struct wl_region *empty = wl_compositor_create_region(compositor);
  wl_surface_set_input_region(win->surface, empty);
  wl_region_destroy(empty);

  wl_surface_commit(win->surface);
  roundtrip_timeout(ROUNDTRIP_TIMEOUT_MS);

  if (!win->configured || win->closed) {
    zwlr_layer_surface_v1_destroy(win->layer);
    wl_surface_destroy(win->surface);
    memset(win, 0, sizeof(*win));
    return failed;
  }

  for (int i = 0; i < BUFFER_SLOTS; i++) {
    if (!alloc_slot(&win->slots[i], win->width * win->scale, win->height * win->scale)) {
      for (int j = 0; j < i; j++) free_slot(&win->slots[j]);
      zwlr_layer_surface_v1_destroy(win->layer);
      wl_surface_destroy(win->surface);
      memset(win, 0, sizeof(*win));
      return failed;
    }
  }

  napi_value out;
  napi_create_int32(env, handle, &out);
  return out;
}

// commit(handle, buffer) -> boolean. Never blocks on a roundtrip: this runs on
// Electron's main thread and a stalled compositor must not freeze the app.
static napi_value Commit(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value no, yes;
  napi_get_boolean(env, false, &no);
  napi_get_boolean(env, true, &yes);
  if (argc < 2 || !init_ok) return no;

  int32_t handle = -1;
  napi_get_value_int32(env, argv[0], &handle);
  if (handle < 0 || handle >= MAX_SURFACES || !windows[handle].used) return no;
  struct layer_window *win = &windows[handle];
  if (win->closed) return no;

  void *data = NULL;
  size_t length = 0;
  bool is_buffer = false;
  napi_is_buffer(env, argv[1], &is_buffer);
  if (!is_buffer) return no;
  napi_get_buffer_info(env, argv[1], &data, &length);

  if (!data) return no;

  pump_events();
  if (win->closed) return no;
  // Sized after the pump, because a configure delivered by it moves win->width
  // and the slots have to follow before anything is copied into them.
  if (!resize_slots(win)) return no;

  const int pixel_width = win->width * win->scale;
  const int pixel_height = win->height * win->scale;
  const size_t expected = (size_t)pixel_width * (size_t)pixel_height * 4;
  if (length < expected) return no;

  struct buffer_slot *slot = &win->slots[win->next_slot];
  // Both slots still held by the compositor means we are ahead of it; dropping
  // this frame is correct, the next paint supersedes it anyway.
  if (slot->busy) {
    slot = &win->slots[(win->next_slot + 1) % BUFFER_SLOTS];
    if (slot->busy) return no;
  } else {
    win->next_slot = (win->next_slot + 1) % BUFFER_SLOTS;
  }

  if (expected > slot->size) return no;

  memcpy(slot->pixels, data, expected);
  slot->busy = 1;
  // Sent here so the density and the frame drawn at it land in one commit.
  if (win->committed_scale != win->scale) {
    wl_surface_set_buffer_scale(win->surface, win->scale);
    win->committed_scale = win->scale;
  }
  wl_surface_attach(win->surface, slot->buffer, 0, 0);
  wl_surface_damage_buffer(win->surface, 0, 0, pixel_width, pixel_height);
  wl_surface_commit(win->surface);
  wl_display_flush(display);
  return yes;
}

static napi_value Destroy(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  if (argc < 1 || !init_ok) return undefined;

  int32_t handle = -1;
  napi_get_value_int32(env, argv[0], &handle);
  if (handle < 0 || handle >= MAX_SURFACES || !windows[handle].used) return undefined;

  struct layer_window *win = &windows[handle];
  // Drained before the slot is cleared, so anything already queued for this
  // window is dispatched against it rather than against its replacement.
  pump_events();
  if (pointer_focus == handle) pointer_focus = -1;
  for (int i = 0; i < BUFFER_SLOTS; i++) free_slot(&win->slots[i]);
  if (win->layer) zwlr_layer_surface_v1_destroy(win->layer);
  if (win->surface) wl_surface_destroy(win->surface);
  memset(win, 0, sizeof(*win));
  wl_display_flush(display);
  return undefined;
}

static napi_value IsClosed(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_value out;
  if (argc < 1 || !init_ok) {
    napi_get_boolean(env, true, &out);
    return out;
  }
  int32_t handle = -1;
  napi_get_value_int32(env, argv[0], &handle);
  if (handle < 0 || handle >= MAX_SURFACES || !windows[handle].used) {
    napi_get_boolean(env, true, &out);
    return out;
  }
  pump_events();
  napi_get_boolean(env, windows[handle].closed ? true : false, &out);
  return out;
}

static void set_event_field(napi_env env, napi_value object, const char *key, double value) {
  napi_value number;
  napi_create_double(env, value, &number);
  napi_set_named_property(env, object, key, number);
}

// outputRects() -> [{name, x, y, width, height, scale}] in logical coordinates,
// which is the space an XWayland window's geometry is reported in too.
static napi_value OutputRects(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value list;
  napi_create_array(env, &list);
  if (!ensure_init()) return list;
  // Monitors get moved and rescaled while the app runs, so take whatever
  // geometry updates are already waiting before answering.
  pump_events();

  uint32_t index = 0;
  for (int i = 0; i < output_count; i++) {
    const struct output_entry *entry = &outputs[i];
    if (!entry->output) continue;
    int scale = entry->scale > 0 ? entry->scale : 1;
    napi_value item, name;
    napi_create_object(env, &item);
    napi_create_string_utf8(env, entry->name, NAPI_AUTO_LENGTH, &name);
    napi_set_named_property(env, item, "name", name);
    // Without xdg-output there is no trustworthy position, so the entry says so
    // and callers fall back to letting the compositor choose the output.
    int width = entry->logical_width > 0 ? entry->logical_width : entry->mode_width / scale;
    int height = entry->logical_height > 0 ? entry->logical_height : entry->mode_height / scale;
    napi_value placed;
    set_event_field(env, item, "x", entry->logical_x);
    set_event_field(env, item, "y", entry->logical_y);
    set_event_field(env, item, "width", width);
    set_event_field(env, item, "height", height);
    set_event_field(env, item, "scale", scale);
    napi_get_boolean(env, entry->has_logical ? true : false, &placed);
    napi_set_named_property(env, item, "placed", placed);
    napi_set_element(env, list, index++, item);
  }
  return list;
}

// setInteractive(handle, boolean) -> boolean. Swaps the input region between the
// whole surface and nothing. Keyboard interactivity stays NONE either way, so a
// clickable overlay still never takes keyboard focus off the game.
static napi_value SetInteractive(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value no, yes;
  napi_get_boolean(env, false, &no);
  napi_get_boolean(env, true, &yes);
  if (argc < 2 || !init_ok) return no;

  int32_t handle = -1;
  napi_get_value_int32(env, argv[0], &handle);
  if (handle < 0 || handle >= MAX_SURFACES || !windows[handle].used) return no;
  bool wanted = false;
  napi_get_value_bool(env, argv[1], &wanted);

  struct layer_window *win = &windows[handle];
  if (win->closed) return no;
  if (wanted) {
    // A null region means the whole surface accepts input.
    wl_surface_set_input_region(win->surface, NULL);
  } else {
    struct wl_region *empty = wl_compositor_create_region(compositor);
    if (!empty) return no;
    wl_surface_set_input_region(win->surface, empty);
    wl_region_destroy(empty);
    if (pointer_focus == handle) pointer_focus = -1;
  }
  win->interactive = wanted ? 1 : 0;
  wl_surface_commit(win->surface);
  wl_display_flush(display);
  return yes;
}

// pollEvents() -> array of pointer events since the last call, oldest first.
// Coordinates are surface-local logical pixels.
static napi_value PollEvents(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value list;
  napi_create_array(env, &list);
  if (!init_ok) return list;

  pump_events();

  for (int i = 0; i < event_count; i++) {
    const struct pointer_event *event = &event_queue[i];
    napi_value item;
    napi_create_object(env, &item);
    set_event_field(env, item, "handle", event->handle);
    set_event_field(env, item, "type", event->type);
    set_event_field(env, item, "x", event->x);
    set_event_field(env, item, "y", event->y);
    set_event_field(env, item, "button", event->button);
    set_event_field(env, item, "dx", event->dx);
    set_event_field(env, item, "dy", event->dy);
    napi_value pressed;
    napi_get_boolean(env, event->pressed ? true : false, &pressed);
    napi_set_named_property(env, item, "pressed", pressed);
    napi_set_element(env, list, (uint32_t)i, item);
  }
  event_count = 0;
  event_dropped = 0;
  return list;
}

// scaleOf(handle) -> buffer pixels per logical pixel, so the caller knows how
// large a frame to render. 0 means the handle is not live.
static napi_value ScaleOf(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_value out;
  int32_t handle = -1;
  if (argc >= 1 && init_ok) napi_get_value_int32(env, argv[0], &handle);
  if (handle < 0 || handle >= MAX_SURFACES || !windows[handle].used) {
    napi_create_int32(env, 0, &out);
    return out;
  }
  napi_create_int32(env, windows[handle].scale, &out);
  return out;
}

// sizeOf(handle) -> {width, height} the compositor granted, or null. create()
// answers with a handle alone, and the size it granted can differ from the ask.
static napi_value SizeOf(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_value out;
  int32_t handle = -1;
  if (argc >= 1 && init_ok) napi_get_value_int32(env, argv[0], &handle);
  if (handle < 0 || handle >= MAX_SURFACES || !windows[handle].used) {
    napi_get_null(env, &out);
    return out;
  }
  napi_create_object(env, &out);
  set_event_field(env, out, "width", windows[handle].width);
  set_event_field(env, out, "height", windows[handle].height);
  return out;
}

// setMargin(handle, top, right, bottom, left) -> boolean. This is how a layer
// surface is moved: the compositor owns the position, the client owns the
// distance from the anchored edges, and the request is live-settable.
static napi_value SetMargin(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value no, yes;
  napi_get_boolean(env, false, &no);
  napi_get_boolean(env, true, &yes);
  if (argc < 5 || !init_ok) return no;

  int32_t handle = -1;
  napi_get_value_int32(env, argv[0], &handle);
  if (handle < 0 || handle >= MAX_SURFACES || !windows[handle].used) return no;
  struct layer_window *win = &windows[handle];
  if (win->closed) return no;

  int32_t top = 0, right = 0, bottom = 0, left = 0;
  napi_get_value_int32(env, argv[1], &top);
  napi_get_value_int32(env, argv[2], &right);
  napi_get_value_int32(env, argv[3], &bottom);
  napi_get_value_int32(env, argv[4], &left);

  zwlr_layer_surface_v1_set_margin(win->layer, top, right, bottom, left);
  // Layer state is double-buffered, so it only lands on a surface commit. No
  // buffer is attached here; the currently shown one keeps its content.
  wl_surface_commit(win->surface);
  wl_display_flush(display);
  return yes;
}

// resize(handle, width, height) -> the granted {width, height}, or null; a
// compositor may grant something else and the caller sizes its frames from the
// answer. The old buffer stays attached across the change, because committing a
// null buffer unmaps the surface and wlroots then reads it as never configured.
static napi_value Resize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value failed;
  napi_get_null(env, &failed);
  if (argc < 3 || !init_ok) return failed;

  int32_t handle = -1, width = 0, height = 0;
  napi_get_value_int32(env, argv[0], &handle);
  napi_get_value_int32(env, argv[1], &width);
  napi_get_value_int32(env, argv[2], &height);
  if (handle < 0 || handle >= MAX_SURFACES || !windows[handle].used) return failed;
  if (width <= 0 || height <= 0) return failed;
  struct layer_window *win = &windows[handle];
  if (win->closed) return failed;

  if (win->width != width || win->height != height) {
    win->width = width;
    win->height = height;
    zwlr_layer_surface_v1_set_size(win->layer, (uint32_t)width, (uint32_t)height);
    wl_surface_commit(win->surface);
    roundtrip_timeout(ROUNDTRIP_TIMEOUT_MS);
    if (win->closed) return failed;
  }
  if (!resize_slots(win)) return failed;

  napi_value out;
  napi_create_object(env, &out);
  set_event_field(env, out, "width", win->width);
  set_event_field(env, out, "height", win->height);
  return out;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"available", NULL, Available, NULL, NULL, NULL, napi_default, NULL},
      {"outputs", NULL, Outputs, NULL, NULL, NULL, napi_default, NULL},
      {"toplevels", NULL, Toplevels, NULL, NULL, NULL, napi_default, NULL},
      {"create", NULL, Create, NULL, NULL, NULL, napi_default, NULL},
      {"commit", NULL, Commit, NULL, NULL, NULL, napi_default, NULL},
      {"destroy", NULL, Destroy, NULL, NULL, NULL, napi_default, NULL},
      {"isClosed", NULL, IsClosed, NULL, NULL, NULL, napi_default, NULL},
      {"scaleOf", NULL, ScaleOf, NULL, NULL, NULL, napi_default, NULL},
      {"sizeOf", NULL, SizeOf, NULL, NULL, NULL, napi_default, NULL},
      {"setInteractive", NULL, SetInteractive, NULL, NULL, NULL, napi_default, NULL},
      {"pollEvents", NULL, PollEvents, NULL, NULL, NULL, napi_default, NULL},
      {"outputRects", NULL, OutputRects, NULL, NULL, NULL, napi_default, NULL},
      {"setMargin", NULL, SetMargin, NULL, NULL, NULL, napi_default, NULL},
      {"resize", NULL, Resize, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
