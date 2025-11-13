# D-Bus Notification Relay

A production-ready Unix socket server that relays notifications to the freedesktop.org Notifications D-Bus interface with optional audio feedback.

Created for system administrators and developers who need to send desktop notifications from background services, cron jobs, or scripts running as different users.


## Why?
My use case is to allow sending notifications from any user running Claude Code – I have one work user and one personal user – and when I am working
I was not able to use Sound hooks or notifications to notify me when Claude Code was waiting for input or was finished.

This fixes that.

## Features

### Server (service.js)
- 🔌 Unix socket server for easy IPC communication
- 🔔 Relays notifications to D-Bus (org.freedesktop.Notifications)
- 🔊 Optional audio feedback with configurable sound files
- 📝 Supports both JSON and plain text payloads
- ⚙️ Fully configurable via environment variables
- 📊 Structured logging with adjustable levels
- 🛡️ Production-ready with error handling and validation
- 🔐 Configurable socket permissions
- 💾 Memory protection (1MB payload limit)

### Client (notify-as)
- 👤 Send notifications to specific users
- 🎨 Simple CLI interface with plain text or JSON
- 🔍 Comprehensive error checking and validation
- ⏱️ Configurable connection timeout
- 🎨 Colored error messages for better visibility
- 📖 Built-in help and usage examples
- 🔧 Works great from cron, systemd, or scripts

## Installation

```bash
npm install
```

## Usage

### Start the service

```bash
node service.js
```

Or make it executable:

```bash
chmod +x service.js
./service.js
```

### Send notifications

#### Using the notify-as client (Recommended)

The `notify-as` client provides a convenient way to send notifications to any user:

**Simple notification:**
```bash
./notify-as robert "Build Complete" "Your project built successfully"
```

**JSON format with advanced options:**
```bash
./notify-as robert --json '{"summary":"Error","body":"Build failed","urgency":"critical","icon":"dialog-error"}'
```

**From root to notify a desktop user:**
```bash
sudo ./notify-as robert "System Update" "Updates are available"
```

**Get help:**
```bash
./notify-as --help
```

#### Using raw socket connection

**JSON format:**
```bash
echo '{"summary":"Hello","body":"World","urgency":"normal","timeout":5000}' | nc -U /tmp/notify-$(id -u).sock
```

**Plain text format:**
```bash
echo "Title|Body text" | nc -U /tmp/notify-$(id -u).sock
```

**Using socat:**
```bash
printf '{"summary":"Test","body":"Message"}' | socat - UNIX-CONNECT:/tmp/notify-$(id -u).sock
```

## Configuration

All configuration is done via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `NOTIFY_RELAY_SOCK` | Unix socket path | `/tmp/notify-<uid>.sock` |
| `NOTIFY_RELAY_SOUND` | Path to sound file | `./825639__1love__1love_fx_winner.wav` |
| `NOTIFY_RELAY_SOUND_ENABLED` | Enable/disable sound playback | `true` |
| `NOTIFY_RELAY_SOUND_TIMEOUT` | Sound playback timeout (ms) | `5000` |
| `NOTIFY_RELAY_SOCKET_PERMISSIONS` | Socket file permissions (octal) | `0666` |
| `NOTIFY_RELAY_LOG_LEVEL` | Logging level: debug\|info\|warn\|error | `info` |

### Example with custom configuration

```bash
NOTIFY_RELAY_LOG_LEVEL=debug \
NOTIFY_RELAY_SOUND_ENABLED=false \
NOTIFY_RELAY_SOCK=/tmp/custom-notify.sock \
node service.js
```

## Client Tool: notify-as

The `notify-as` script is a bash client for sending notifications through the relay service. It's particularly useful for:
- System administrators notifying desktop users
- Cron jobs sending user notifications
- Scripts running as root that need to show desktop notifications
- Cross-user notification delivery

### Installation

Make the script executable:
```bash
chmod +x notify-as
```

Optionally, install it system-wide:
```bash
sudo cp notify-as /usr/local/bin/
```

### Usage

**Basic syntax:**
```bash
notify-as <username> <title> [body]
notify-as <username> --json '<json-payload>'
```

**Examples:**

```bash
# Simple notification
notify-as john "Build Complete" "Your project built successfully"

# Notification with empty body
notify-as john "Quick Alert"

# JSON format for advanced options
notify-as john --json '{
  "summary": "Critical Error",
  "body": "Database connection lost",
  "urgency": "critical",
  "icon": "dialog-error",
  "timeout": 10000
}'

# Use from cron job
0 */6 * * * /usr/local/bin/notify-as john "Reminder" "Time to take a break"

# Notify from systemd service
ExecStartPost=/usr/local/bin/notify-as john "Service Started" "Application is now running"
```

### Client Configuration

The client supports these environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `NOTIFY_RELAY_SOCK` | Custom socket path | `/tmp/notify-<uid>.sock` |
| `NOTIFY_AS_TIMEOUT` | Connection timeout in seconds | `5` |

**Example with custom configuration:**
```bash
NOTIFY_RELAY_SOCK=/custom/path.sock notify-as john "Test" "Custom socket"
```

### Client Requirements

- `bash` 4.0 or later
- `socat` - Install with:
  - Debian/Ubuntu: `sudo apt install socat`
  - RHEL/CentOS: `sudo yum install socat`
  - Arch: `sudo pacman -S socat`

### Troubleshooting

**Error: User 'username' not found**
- Verify the username is correct: `id username`

**Error: Socket not found**
- Ensure the relay service is running for the target user
- Check the socket path matches: `ls -la /tmp/notify-*.sock`

**Error: Permission denied for socket**
- Check socket permissions: `ls -l /tmp/notify-*.sock`
- Adjust `NOTIFY_RELAY_SOCKET_PERMISSIONS` on the server
- Or adjust your group membership

**Error: 'socat' command not found**
- Install socat package (see requirements above)

## Payload Format

### JSON Payload

```json
{
  "summary": "Notification Title",
  "body": "Notification body text",
  "urgency": "low|normal|critical",
  "icon": "dialog-information",
  "timeout": 5000,
  "app": "my-app",
  "sound": false,
  "category": "email.arrived"
}
```

**Fields:**
- `summary` (required): Notification title
- `body` (optional): Notification message
- `urgency` (optional): `low`, `normal`, or `critical` (default: `normal`)
- `icon` (optional): Icon name or path
- `timeout` (optional): Display timeout in milliseconds (-1 for default)
- `app` (optional): Application name (default: `notify-relay`)
- `sound` (optional): Set to `false` to disable sound for this notification
- `category` (optional): Notification category

### Plain Text Payload

Format: `Title|Body`

```
My Title|This is the body text
```

## Logging

The service provides structured logging with timestamps:

```
[2024-01-13T10:30:45.123Z] [INFO] D-Bus Notification Relay Service starting...
[2024-01-13T10:30:45.234Z] [INFO] Server listening on /tmp/notify-1000.sock
[2024-01-13T10:30:46.345Z] [INFO] Notification sent: "Hello World" (ID: 42)
```

Log levels:
- `debug`: Detailed diagnostic information
- `info`: General informational messages (default)
- `warn`: Warning messages
- `error`: Error messages

## Security Considerations

- Default socket permissions (`0666`) allow all users to send notifications
- For production, consider restricting permissions:
  ```bash
  NOTIFY_RELAY_SOCKET_PERMISSIONS=0600 node service.js
  ```
- Payload size is limited to 1MB to prevent memory exhaustion
- The service validates all incoming payloads

## systemd Integration

Create `/etc/systemd/user/notify-relay.service`:

```ini
[Unit]
Description=D-Bus Notification Relay
After=dbus.service

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/service.js
Restart=on-failure
Environment="NOTIFY_RELAY_LOG_LEVEL=info"

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user enable notify-relay
systemctl --user start notify-relay
```

## Use Cases

This notification relay system is perfect for:

**System Administration**
- Root processes notifying desktop users about system events
- Automated maintenance scripts showing completion status
- Security alerts displayed to logged-in users

**Development & CI/CD**
- Build systems notifying developers when builds complete
- Test runners showing pass/fail status
- Deployment scripts confirming successful deployments

**Automation & Monitoring**
- Backup scripts reporting completion status
- Monitoring tools alerting about system issues
- Cron jobs providing user feedback

**Multi-User Environments**
- Services running as one user notifying another user
- Centralized notification routing for server applications
- Cross-user communication without direct D-Bus access

### Example Workflow: Backup Script

```bash
#!/bin/bash
# /usr/local/bin/backup-notify.sh

USER="robert"  # Desktop user to notify

# Start backup
notify-as "$USER" "Backup Started" "Database backup in progress..."

if /usr/local/bin/run-backup.sh; then
    # Success
    notify-as "$USER" --json '{
        "summary": "Backup Complete",
        "body": "Database backed up successfully",
        "urgency": "low",
        "icon": "emblem-default"
    }'
else
    # Failure
    notify-as "$USER" --json '{
        "summary": "Backup Failed",
        "body": "Check logs for details",
        "urgency": "critical",
        "icon": "dialog-error"
    }'
fi
```

Add to root's crontab:
```cron
0 2 * * * /usr/local/bin/backup-notify.sh
```

## Requirements

**Server:**
- Node.js (tested with v14+)
- D-Bus session bus
- `aplay` (for audio feedback, optional)

**Client:**
- `bash` 4.0 or later
- `socat` command-line tool

## License

ISC

## Author

@robertsvendsen
