# Kafka Connector for IBM TDI

A connector that lets your TDI Assembly Lines read from and write to Apache Kafka topics — no Kafka expertise required.

---

## What Is This?

Apache Kafka is a messaging system used to move data between applications reliably and at scale. Think of a **topic** as a channel or feed that other systems publish updates to. This connector gives TDI the ability to:

- **Read** messages from a Kafka topic (one by one, like any other Iterator connector)
- **Write** messages to a Kafka topic (in AddOnly mode)
- **Look up** a specific message by its exact position in the topic
- **Delete** records on log-compacted topics (by sending a tombstone message)
- **Manage** the Kafka cluster itself — create topics, inspect consumer groups, etc. (Admin mode)

---

## Requirements

- IBM TDI (Tivoli Directory Integrator / Security Directory Integrator)
- A running Kafka broker that your TDI server can reach
- The Kafka client JAR on the TDI classpath (the connector uses the standard Apache Kafka client library) included in the repo under the libs folder. This is done by copying it to the V72\jars subfolder, or a custom jars folder defined in solution.properties (com.ibm.di.loader.userjars=customjars). Note that a relative path places this folder under the Solution Directory.

> **Just want to test locally?**  
> A `docker-compose.yml` is included. If you have Docker installed, run:
> ```
> docker compose up -d
> ```
> This starts a single-node Kafka broker on `localhost:9092` — ready to use immediately, no configuration needed.

---

## Setting Up the Connector

Add the connector to your Assembly Line as you would any other TDI connector. The parameters below appear in the connector's configuration form.

### Required Parameters

| Parameter | What It Does |
|---|---|
| **Bootstrap Servers** | The address of your Kafka broker, e.g. `kafka.mycompany.com:9092`. If you have multiple brokers, list them separated by commas. |
| **Topic** | The name of the Kafka topic to read from or write to. |

### Optional Parameters

| Parameter | Default | What It Does |
|---|---|---|
| **Connector Mode** | `client` | Use `client` for normal read/write operations. The option `admin` is for cluster management tasks, but is not yet implemented. |
| **Consumer Group ID** | `tdi-consumer` | A name that identifies this connector when reading. Kafka uses this to remember where you left off. Each connector instance that reads independently should have a unique group ID. |
| **Client ID** | *(connector name)* | A label shown in Kafka's logs. Useful for troubleshooting. |
| **Auto Offset Reset** | `latest` | What to do when there is no saved reading position. `latest` means start from new messages only; `earliest` means replay everything from the beginning of the topic. |
| **Start Offset** | *(blank)* | If set, forces reading to start at this exact position in the topic, ignoring any previously saved position. Set to `0` to replay from the very beginning. |
| **Poll Timeout (ms)** | `2000` | How long (in milliseconds) the connector waits for new messages before giving up and ending the AL cycle. |
| **Max Poll Records** | `100` | How many messages to fetch at once internally. You still process them one at a time — this just controls the batch size behind the scenes. |
| **Producer Acknowledgement** | `1` | How many confirmations to wait for before moving on after writing a message. `1` is a safe default. `all` is more durable but slower. `0` is fastest but offers no delivery guarantee. |
| **Message Key Attribute** | *(blank)* | The name of a Work Entry attribute to use as the Kafka message key. Messages with the same key always go to the same partition, which preserves order. Required if you intend to delete records. |

---

## Connector Modes (Iterator, AddOnly, Lookup, Delete)

### Iterator — Reading Messages

Use this mode to process incoming Kafka messages one at a time in an Assembly Line, just like reading from a file or database.

Each message arrives as a Work Entry with these attributes automatically populated:

| Attribute | Contains |
|---|---|
| `kafka.topic` | The topic the message came from |
| `kafka.partition` | Which partition the message was in |
| `kafka.offset` | The message's exact position in the topic |
| `kafka.key` | The message key (may be blank) |
| `kafka.timestamp` | When the message was produced |

If the message body is a JSON object, its fields are also merged directly into the Work Entry for easy mapping.

The connector automatically saves your reading position after each message, so if TDI restarts, it picks up where it left off.

### AddOnly — Writing Messages

Use this mode to publish data to a Kafka topic. The connector serialises the Work Entry as JSON and sends it as a message.

If you have set **Message Key Attribute**, the value of that attribute becomes the message's key.

### Lookup — Finding a Specific Message

Use this mode (with Link Criteria) to retrieve a message at an exact position in the topic. You must supply `kafka.offset` in the Link Criteria, and optionally `kafka.partition`.

This is useful when you have stored an offset from a previous run and need to go back and re-read that specific record.

### Delete — Removing a Record (Compacted Topics Only)

On log-compacted topics, deleting a record means sending a *tombstone* — a message with a key but no value — which tells Kafka to eventually remove all prior messages with that key.

**The Message Key Attribute parameter must be set** for Delete mode to work. The connector refuses to send a tombstone without a key, since without a key Kafka has no way of knowing which record to delete.

---

## Tips & Common Questions

**Q: I want to replay all messages from the beginning of the topic. How?**  
Set **Start Offset** to `0`. This overrides any saved position and reads from the very first message in the topic.

**Q: Two of my Assembly Lines are consuming from the same topic. They're interfering with each other.**  
Give each one a different **Consumer Group ID**. Kafka tracks reading position per group, so two ALs with the same group ID will split the messages between them rather than each seeing all of them.

**Q: The AL ends immediately without processing any messages.**  
This usually means the topic is empty or there are no *new* messages since the last run. If you want to re-read existing messages, set **Start Offset** to `0` or `earliest` in **Auto Offset Reset**.

**Q: How do I write to a different topic per entry?**  
Set the `topic` attribute on the Work Entry before the connector's step. When present, the connector uses the Work Entry's `topic` attribute in preference to the one set in the connector parameters.

**Q: Kafka clients are expensive to start — will the connector reconnect on every AL run?**  
No. The connector caches its Kafka clients in the JVM for the lifetime of the TDI server process, so they are reused across AL runs without reconnecting each time.

---

## Testing Locally with Docker

The included `docker-compose.yml` starts a minimal Kafka broker with no external dependencies:

```
docker compose up -d
```

The broker will be available at `localhost:9092`. Topics are created automatically on first use. Use this as your **Bootstrap Servers** value when testing.

To stop the broker:

```
docker compose down
```

---

## Supported Operations Summary

| TDI Mode | Supported | Notes |
|---|---|---|
| Iterator | ✅ | Reads messages from a topic |
| AddOnly | ✅ | Writes messages to a topic |
| Lookup | ✅ | Retrieves message by offset |
| Delete | ✅ | Sends a tombstone (key required) |
| Modify | ❌ | Kafka is append-only; use AddOnly to supersede a record |
