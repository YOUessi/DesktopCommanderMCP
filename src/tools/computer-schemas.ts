/**
 * Opt-in Computer Use tool schemas.
 * All coordinates are pixels in the latest returned *scaled screenshot*, not OS pixels.
 * The screenshot_id binds mutations to an observation and expires quickly.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const coordinate = z.number().int().min(0);
const screenshotId = z.string().uuid();
const observed = { screenshot_id: screenshotId };
const afterAction = { return_screenshot: z.boolean().optional().default(true) };

export const ComputerScreenshotArgsSchema = z.object({
  max_width: z.number().int().min(320).max(1920).optional().default(1280),
  max_height: z.number().int().min(240).max(1440).optional().default(1000),
  quality: z.number().int().min(35).max(90).optional().default(72),
});
export const ComputerScreenInfoArgsSchema = z.object({});
export const ComputerWindowsArgsSchema = z.object({});
export const ComputerClickArgsSchema = z.object({
  ...observed, x: coordinate, y: coordinate,
  button: z.enum(['left', 'right', 'middle']).optional().default('left'),
  clicks: z.number().int().min(1).max(2).optional().default(1),
  ...afterAction,
});
export const ComputerTypeArgsSchema = z.object({
  ...observed,
  text: z.string().min(1).max(2000),
  ...afterAction,
});
export const ComputerKeyArgsSchema = z.object({
  ...observed,
  keys: z.array(z.string().min(1).max(24)).min(1).max(4),
  ...afterAction,
});
export const ComputerScrollArgsSchema = z.object({
  ...observed,
  clicks: z.number().int().min(-20).max(20),
  x: coordinate.optional(), y: coordinate.optional(),
  ...afterAction,
});
export const ComputerDragArgsSchema = z.object({
  ...observed,
  from_x: coordinate, from_y: coordinate, to_x: coordinate, to_y: coordinate,
  duration_ms: z.number().int().min(100).max(2000).optional().default(450),
  ...afterAction,
});

export const computerToolArgSchemas = {
  computer_screenshot: ComputerScreenshotArgsSchema,
  computer_screen_info: ComputerScreenInfoArgsSchema,
  computer_list_windows: ComputerWindowsArgsSchema,
  computer_click: ComputerClickArgsSchema,
  computer_type: ComputerTypeArgsSchema,
  computer_key: ComputerKeyArgsSchema,
  computer_scroll: ComputerScrollArgsSchema,
  computer_drag: ComputerDragArgsSchema,
};
export type ComputerToolName = keyof typeof computerToolArgSchemas;

const definitions: Array<{
  name: ComputerToolName; description: string; readOnly: boolean;
}> = [
  { name: 'computer_screenshot', readOnly: true,
    description: 'Capture the primary monitor as a compressed JPEG image. Returns a screenshot_id and screenshot pixel dimensions. All coordinate actions MUST use x/y on this returned screenshot and its screenshot_id. The image may contain sensitive user information.' },
  { name: 'computer_screen_info', readOnly: true,
    description: 'Get primary desktop dimensions and platform. Screenshots and clicking require an active unlocked GUI session.' },
  { name: 'computer_list_windows', readOnly: true,
    description: 'List available desktop windows, if supported by the OS and desktop session. macOS requires Accessibility permission. Linux X11 requires wmctrl.' },
  { name: 'computer_click', readOnly: false,
    description: 'Click at x/y in the latest screenshot, using its screenshot_id. Requires explicit opt-in and an observed desktop. Supports single/double and left/right/middle click. Returns a fresh screenshot by default.' },
  { name: 'computer_type', readOnly: false,
    description: 'Type text into the focused desktop application, bound to a recent screenshot_id. Non-ASCII text may use the system clipboard; do not use for passwords or other secrets. Returns fresh screenshot by default.' },
  { name: 'computer_key', readOnly: false,
    description: 'Press a keyboard shortcut (e.g. ["command","l"] on Mac, ["ctrl","l"] on Linux). Requires recent screenshot_id. Returns fresh screenshot by default.' },
  { name: 'computer_scroll', readOnly: false,
    description: 'Scroll the currently hovered window, optionally moving to x/y on a recent screenshot. Positive clicks scroll up; negative scroll down. Returns fresh screenshot by default.' },
  { name: 'computer_drag', readOnly: false,
    description: 'Drag from one screenshot pixel coordinate to another using the recent screenshot_id. Use only after visually verifying the target. Returns fresh screenshot by default.' },
];

export const computerToolDefinitions = definitions.map(({ name, description, readOnly }) => ({
  name,
  description,
  inputSchema: zodToJsonSchema(computerToolArgSchemas[name]),
  annotations: {
    title: name.replace(/_/g, ' '),
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    openWorldHint: false,
  },
}));
