// 20260418 1126 Initial
// 20260419 1112 Added Claude code. Now to start reading
// 20260421 2018 Iterator and AddOnly working
// 20260423 1205 Iterator, Lookup and AddOnly working
// 20260423 1600 Admin client operations: listTopics, listConsumerGroups, getOffsets, createTopic, deleteTopic

// =============================================================================
// KAFKA CONNECTOR — PARAMETER DEFINITIONS
// Reference object for form generation and documentation.
// Not used at runtime — safe to move to a shared Script component.
// =============================================================================

// Must be the same in the Form Init Script!

// vrs 20260919
var kafkaConnectorParams = {

    connector_mode: {
        title:       "Client Type",
        tooltip:     "Client (producer/consumer) or Admin (cluster operations)",
        description: "Determines which Kafka clients are instantiated. 'client' initializes a full set — consumer, lookup consumer and producer. 'admin' creates only an AdminClient for cluster management: listing topics, listing consumer groups, inspecting offsets, creating and deleting topics."
    },

    admin_operation: {
        title:       "Admin Operation",
        tooltip:     "Which admin operation this connector instance performs",
        description: "Only used when Client Type is 'admin'. Iterator-mode operations: 'listTopics' — one Entry per topic; 'listConsumerGroups' — one Entry per group; 'getOffsets' — one Entry per partition (requires Topic; include Consumer Group ID for lag). AddOnly-mode operations: 'createTopic' — creates the topic specified by Topic (or kafka.topic on conn); 'deleteTopic' — deletes it."
    },

    admin_partitions: {
        title:       "Partitions",
        tooltip:     "Number of partitions for createTopic",
        description: "Used by createTopic when kafka.partitions is not present on conn. Defaults to 1."
    },

    admin_replication_factor: {
        title:       "Replication Factor",
        tooltip:     "Replication factor for createTopic",
        description: "Used by createTopic when kafka.replication_factor is not present on conn. Defaults to 1."
    },

    bootstrap_servers: {
        title:       "Bootstrap Servers",
        tooltip:     "Kafka broker address(es), e.g. host:port,host:port",
        description: "A comma-separated list of host:port pairs for initial cluster connection. Kafka discovers remaining brokers automatically. Required in both client and admin modes."
    },

    topic: {
        title:       "Topic",
        tooltip:     "Kafka topic to read from or write to",
        description: "The Kafka topic this connector interacts with. In Iterator mode messages are consumed from it; in AddOnly mode messages are produced to it. Optional in admin mode unless the operation is topic-specific."
    },

    group_id: {
        title:       "Consumer Group ID",
        tooltip:     "Identifies this consumer within a Kafka consumer group",
        description: "Used by Kafka to track read progress and distribute partitions across group members. Must be unique per connector instance to avoid partition conflicts. Only relevant when consuming messages."
    },

    client_id: {
        title:       "Client ID",
        tooltip:     "Human-readable name for this connector's Kafka client",
        description: "Label attached to all broker requests from this connector. Appears in broker logs and monitoring tools. Defaults to a generated value if blank."
    },

    auto_offset_reset: {
        title:       "Auto Offset Reset",
        tooltip:     "Where to start consuming when no committed offset exists",
        description: "'earliest' replays from the beginning of the topic; 'latest' skips to new messages only. Only fires when no committed offset exists for this group and start_offset is blank."
    },

    poll_timeout_ms: {
        title:       "Poll Timeout (ms)",
        tooltip:     "How long to block waiting for messages per poll cycle",
        description: "Maximum milliseconds the consumer blocks on each poll() call. Higher values reduce CPU spin on quiet topics but slow shutdown response. Must never be zero."
    },

    max_poll_records: {
        title:       "Max Poll Records",
        tooltip:     "Maximum messages returned per poll call",
        description: "Caps messages returned per poll(). Smaller values give finer error handling; larger values improve throughput. Tune down if per-message processing is slow to avoid exceeding Kafka's max.poll.interval.ms."
    },

    acks: {
        title:       "Producer Acknowledgement",
        tooltip:     "Durability guarantee for produced messages",
        description: "'0' = fire and forget; '1' = leader broker only; 'all' = full in-sync replica set. Higher values increase durability at the cost of latency."
    },

    key_attribute: {
        title:       "Message Key Attribute",
        tooltip:     "Work Entry attribute to use as the Kafka message key",
        description: "The conn Entry attribute used as the Kafka message key when producing. Messages with the same key always route to the same partition, preserving order. Required when producing tombstones. Leave blank for null key, which round-robins across partitions."
    },

    start_offset: {
        title:       "Start Offset",
        tooltip:     "Optional. Force all partitions to start at this offset",
        description: "When set, uses assign() instead of subscribe() and seeks all partitions to this offset before polling. Leave blank to resume from the last committed offset via subscribe(). Set to 0 to replay from the beginning."
    }

};


// =============================================================================
// GLOBAL STATE
// Persists across all connector function calls within a single AL run.
// Kafka clients are cached in JVM System Properties to survive across AL runs.
// =============================================================================

var __consumer        = null;   // KafkaConsumer — forward iteration and commits
var __lookupConsumer  = null;   // KafkaConsumer — seek/poll only, never commits
var __producer        = null;   // KafkaProducer — all message production
var __adminClient     = null;   // AdminClient   — cluster management operations
var __msgBuffer       = null;   // ArrayList — current poll batch (client mode)
var __bufferIndex     = 0;      // Current position within __msgBuffer
var __adminBuffer     = null;   // ArrayList — pre-built Entries for admin Iterator ops
var __adminIndex      = 0;      // Current position within __adminBuffer
var __mode            = null;   // 'client' or 'admin'

var __cacheKeyConsumer       = 'kafka.consumer::'       + connector.getName();
var __cacheKeyLookupConsumer = 'kafka.lookupconsumer::' + connector.getName();
var __cacheKeyProducer       = 'kafka.producer::'       + connector.getName();
var __cacheKeyAdmin          = 'kafka.admin::'          + connector.getName();

// Kafka class references
var STRING_SERIALIZER   = 'org.apache.kafka.common.serialization.StringSerializer';
var STRING_DESERIALIZER = 'org.apache.kafka.common.serialization.StringDeserializer';


// =============================================================================
// GENERAL HELPERS
// =============================================================================

// Centralized log function
function logmsg(lvl, msg) {
	if (typeof(msg) == "undefined") {
		msg = lvl
		lvl = "INFO"
	}
	
	msg = msg || "";
	lvl = lvl || "INFO";
	
	if (!(task instanceof com.ibm.di.server.AssemblyLine)) main.logmsg(lvl, msg)
	else task.logmsg(lvl, msg)
}

// Safe parameter retrieval with fallback default
function getParam(name, defaultVal) {
    var v = connector.getParam(name);
    return (v != null && String(v).trim() !== '') ? String(v).trim() : defaultVal;
}

// Required parameter — throws clearly if missing
function requireParam(name, context) {
    var v = getParam(name, '');
    if (v === '') {
        throw new java.lang.RuntimeException(
            context + ': parameter "' + name + '" is required'
        );
    }
    return v;
}

// Consistent error message extraction from Java or JS exceptions
function getErrorMsg(ex) {
    return (ex && ex.message) ? ex.message : String(ex);
}

// Build java.util.Properties from a JS object — skips null/blank values
function buildProperties(map) {
    var props = new java.util.Properties();
    for (var key in map) {
        if (map[key] != null && String(map[key]).trim() !== '') {
            props.put(String(key), String(map[key]));
        }
    }
    return props;
}

function recordToEntry(rec) {
	var e = system.newEntry();
	e['kafka.topic']     = String(rec.topic());
	e['kafka.partition'] = String(rec.partition());
	e['kafka.offset']    = String(rec.offset());
	e['kafka.key']       = rec.key() != null ? ('' + rec.key()).trim() : '';
	e['kafka.timestamp'] = String(rec.timestamp());

	var v = rec.value() != null ? ('' + rec.value()).trim() : '';

	// Replacing dot in field names with underscore
	var vFixed = v.replace(/"(\w+)\.(\w+)"\s*:/g, '"$1_$2":');

	// Include top level fields, plus the property values of the kafka.value field and its value field
	if (vFixed.indexOf('{') === 0 && vFixed.lastIndexOf('}') === vFixed.length - 1) {
		var vObj  = fromJson(vFixed);
		var v2    = vObj['kafka_value'];  // note: dot already replaced to underscore by this point
		delete vObj['kafka_value'];

		e.merge(e.fromJSON(toJson(vObj)));
		if (v2 != null) {
			e.merge(e.fromJSON(v2));
		}
	}

	return e;
}

// Resolve message key from conn using key_attribute parameter.
// Returns null if key_attribute is unset or the attribute has no value.
function resolveKey() {
    var keyAttr = getParam('key_attribute', '');
    if (keyAttr === '') return null;
    var keyVal = entry.getString(keyAttr);
    return (keyVal != null && String(keyVal).trim() !== '') ? String(keyVal) : null;
}


// =============================================================================
// JVM CACHE HELPERS
// Kafka clients are expensive to create. Caching them in JVM System Properties
// lets them survive across AL runs without reconnecting each time.
// Cache keys are namespaced per connector instance to avoid collisions.
// =============================================================================

// Retrieve from JVM cache or create, cache and return a new instance
function getOrCreate(cacheKey, factory) {
    var cached = java.lang.System.getProperties().get(cacheKey);
    if (cached == null) {
        logmsg('INFO', 'Creating ' + cacheKey);
        cached = factory();
        java.lang.System.getProperties().put(cacheKey, cached);
    } else {
        logmsg('INFO', 'Reusing ' + cacheKey);
    }
    return cached;
}

// Close a client safely, remove from JVM cache, nullify the reference
function safeClose(client, label, cacheKey) {
    if (client == null) return null;
    try {
        client.close();
        logmsg('INFO', label + ' closed');
    } catch(ex) {
        logmsg('WARN', 'Error closing ' + label + ': ' + getErrorMsg(ex));
    }
    java.lang.System.getProperties().remove(cacheKey);
    return null;
}


// =============================================================================
// CLIENT FACTORIES
// Each factory builds a Properties object from connector parameters and
// returns a new Kafka client. Called only by getOrCreate() — never directly.
// =============================================================================

function createConsumer() {
    return new org.apache.kafka.clients.consumer.KafkaConsumer(buildProperties({
        'bootstrap.servers':  getParam('bootstrap_servers', 'localhost:9092'),
        'group.id':           getParam('group_id',          'tdi-consumer'),
        'client.id':          getParam('client_id',         connector.getName() + '-consumer'),
        'auto.offset.reset':  getParam('auto_offset_reset', 'latest'),
        'max.poll.records':   getParam('max_poll_records',  '100'),
        'enable.auto.commit': 'false',
        'key.deserializer':   STRING_DESERIALIZER,
        'value.deserializer': STRING_DESERIALIZER
    }));
}

function createLookupConsumer() {
    return new org.apache.kafka.clients.consumer.KafkaConsumer(buildProperties({
        'bootstrap.servers':  getParam('bootstrap_servers', 'localhost:9092'),
        'client.id':          getParam('client_id',         connector.getName() + '-lookup'),
        'enable.auto.commit': 'false',
        'key.deserializer':   STRING_DESERIALIZER,
        'value.deserializer': STRING_DESERIALIZER
    }));
}

function createProducer() {
    return new org.apache.kafka.clients.producer.KafkaProducer(buildProperties({
        'bootstrap.servers': getParam('bootstrap_servers', 'localhost:9092'),
        'client.id':         getParam('client_id',         connector.getName() + '-producer'),
        'acks':              getParam('acks',               '1'),
        'key.serializer':    STRING_SERIALIZER,
        'value.serializer':  STRING_SERIALIZER
    }));
}

function createAdminClient() {
    return org.apache.kafka.clients.admin.AdminClient.create(buildProperties({
        'bootstrap.servers': getParam('bootstrap_servers', 'localhost:9092'),
        'client.id':         getParam('client_id',         connector.getName() + '-admin')
    }));
}

// =============================================================================
// PRODUCE HELPER
// Shared by putEntry() and deleteEntry(). Appends a record to the topic and
// blocks on future.get() for synchronous broker acknowledgement.
// An 'operation' header signals intent to consumers that care about the
// distinction between add and delete. Consumers ignoring headers are unaffected.
// value=null produces a tombstone — signals logical deletion to consumers
// of log-compacted topics.
// =============================================================================

function produceRecord(topic, key, value, operation) {

    var record = (key != null)
        ? new org.apache.kafka.clients.producer.ProducerRecord(topic, key, value)
        : new org.apache.kafka.clients.producer.ProducerRecord(topic, value);

    record.headers().add(
        new org.apache.kafka.common.header.internals.RecordHeader(
            'operation', new java.lang.String(operation).getBytes()
        )
    );

    try {
        __producer.send(record).get();
        logmsg('INFO', 'Produced [' + operation + '] to ' + topic
            + (key   != null ? ' key=' + key : ' (no key)')
            + (value == null ? ' (tombstone)' : ''));
    } catch(ex) {
        throw new java.lang.RuntimeException(
            'Kafka produce [' + operation + '] failed: ' + getErrorMsg(ex)
        );
    }
}


// =============================================================================
// INITIALIZE
// Called once at AL startup or after a reconnect.
// In client mode all three Kafka clients are initialized unconditionally —
// consumer, lookup consumer and producer are all available for use regardless
// of which connector functions the AL intends to call. This allows the
// connector to be used in Passive mode or driven freely from AL hook scripts
// without being constrained to a single operational role.
// In admin mode only the AdminClient is created.
// =============================================================================

function initialize() {

    logmsg('INFO', 'Initializing: ' + connector.getName());

    __mode = getParam('connector_mode', 'client');

    if (__mode === 'admin') {
        __adminClient    = getOrCreate(__cacheKeyAdmin,          createAdminClient);
    } else {
        __consumer       = getOrCreate(__cacheKeyConsumer,       createConsumer);
        __lookupConsumer = getOrCreate(__cacheKeyLookupConsumer, createLookupConsumer);
        __producer       = getOrCreate(__cacheKeyProducer,       createProducer);
    }

    logmsg('INFO', 'Initialized: ' + connector.getName());
}


// =============================================================================
// TERMINATE
// Pre-close operations run first while clients are still live.
// All clients are then closed and removed from JVM cache.
// safeClose() returns null — assignments clean up the global references.
// Lookup consumer has no pre-close commit — it never owns offsets.
// =============================================================================

function terminate() {

    logmsg('INFO', 'Terminating: ' + connector.getName());

    if (__consumer != null) {
        try { __consumer.commitSync(); }
        catch(ex) { logmsg('WARN', 'Final commit failed: ' + getErrorMsg(ex)); }
    }

    if (__producer != null) {
        try { __producer.flush(); }
        catch(ex) { logmsg('WARN', 'Producer flush failed: ' + getErrorMsg(ex)); }
    }

    __consumer       = safeClose(__consumer,      'KafkaConsumer',        __cacheKeyConsumer);
    __lookupConsumer = safeClose(__lookupConsumer, 'Lookup KafkaConsumer', __cacheKeyLookupConsumer);
    __producer       = safeClose(__producer,       'KafkaProducer',        __cacheKeyProducer);
    __adminClient    = safeClose(__adminClient,    'AdminClient',          __cacheKeyAdmin);
}


// =============================================================================
// ADMIN HELPERS
// Each adminSelect* function populates __adminBuffer with pre-built Entries.
// selectEntries() dispatches to the right one; getNextEntry() drains the buffer.
// Each adminExec* function performs a single write-style cluster operation,
// called from putEntry() when connector_mode is 'admin'.
// All AdminClient calls block via .get() — admin ops are infrequent enough
// that async complexity adds no value here.
// =============================================================================

// listTopics — one Entry per topic, with partition count and replication factor.
// Two round trips: listTopics() for names, then describeTopics() for detail.
function adminSelectListTopics() {
    var listings  = __adminClient.listTopics().listings().get();
    var nameList  = new java.util.ArrayList();
    for (var listing in listings) {
        nameList.add(listing.name());
    }

    var descriptions = __adminClient.describeTopics(nameList).allTopicNames().get();
    __adminBuffer    = new java.util.ArrayList();

    for (var name in descriptions) {
        var desc  = descriptions.get(name);
        var parts = desc.partitions();
        var e     = system.newEntry();
        e['kafka.topic']              = String(desc.name());
        e['kafka.internal']           = String(desc.isInternal());
        e['kafka.partitions']         = String(parts.size());
        e['kafka.replication_factor'] = parts.size() > 0 ? String(parts.get(0).replicas().size()) : '0';
        __adminBuffer.add(e);
    }

    logmsg('INFO', 'listTopics: ' + __adminBuffer.size() + ' topic(s)');
}


// listConsumerGroups — one Entry per group.
// Two round trips: listConsumerGroups() for IDs, describeConsumerGroups()
// for state and member count which are not available on ConsumerGroupListing.
function adminSelectListConsumerGroups() {
    var groups = __adminClient.listConsumerGroups().all().get();
    var idList = new java.util.ArrayList();
    for (var grp in groups) {
        idList.add(grp.groupId());
    }

    var descriptions = __adminClient.describeConsumerGroups(idList).all().get();
    __adminBuffer    = new java.util.ArrayList();

    for (var groupId in descriptions) {
        var desc = descriptions.get(groupId);
        var e    = system.newEntry();
        e['kafka.group_id']     = String(desc.groupId());
        e['kafka.state']        = String(desc.state());
        e['kafka.member_count'] = String(desc.members().size());
        e['kafka.coordinator']  = String(desc.coordinator().host()) + ':' + String(desc.coordinator().port());
        __adminBuffer.add(e);
    }

    logmsg('INFO', 'listConsumerGroups: ' + __adminBuffer.size() + ' group(s)');
}


// getOffsets — one Entry per partition for the configured topic.
// Fetches begin and end offsets in two listOffsets() calls.
// If group_id is also set, fetches committed offsets and computes lag.
function adminSelectGetOffsets() {
    var topic   = requireParam('topic', 'getOffsets');
    var groupId = getParam('group_id', '');

    var nameList = new java.util.ArrayList();
    nameList.add(topic);
    var desc       = __adminClient.describeTopics(nameList).allTopicNames().get().get(topic);
    var partitions = desc.partitions();

    var OffsetSpec   = org.apache.kafka.clients.admin.OffsetSpec;
    var beginRequest = new java.util.HashMap();
    var endRequest   = new java.util.HashMap();

    for (var i = 0; i < partitions.size(); i++) {
        var tp = new org.apache.kafka.common.TopicPartition(topic, partitions.get(i).partition());
        beginRequest.put(tp, OffsetSpec.earliest());
        endRequest.put(tp,   OffsetSpec.latest());
    }

    var beginOffsets     = __adminClient.listOffsets(beginRequest).all().get();
    var endOffsets       = __adminClient.listOffsets(endRequest).all().get();
    var committedOffsets = null;

    if (groupId !== '') {
        committedOffsets = __adminClient.listConsumerGroupOffsets(groupId)
            .partitionsToOffsetAndMetadata().get();
    }

    __adminBuffer = new java.util.ArrayList();

    for (var i = 0; i < partitions.size(); i++) {
        var partNum     = partitions.get(i).partition();
        var tp          = new org.apache.kafka.common.TopicPartition(topic, partNum);
        var beginOffset = beginOffsets.get(tp).offset();
        var endOffset   = endOffsets.get(tp).offset();
        var e           = system.newEntry();

        e['kafka.topic']        = topic;
        e['kafka.partition']    = String(partNum);
        e['kafka.begin_offset'] = String(beginOffset);
        e['kafka.end_offset']   = String(endOffset);

        if (committedOffsets != null) {
            var committed = committedOffsets.get(tp);
            if (committed != null) {
                var committedOffset         = committed.offset();
                e['kafka.committed_offset'] = String(committedOffset);
                e['kafka.lag']              = String(endOffset - committedOffset);
            } else {
                e['kafka.committed_offset'] = '';
                e['kafka.lag']              = '';
            }
        }

        __adminBuffer.add(e);
    }

    logmsg('INFO', 'getOffsets: ' + __adminBuffer.size() + ' partition(s) for topic ' + topic
        + (groupId !== '' ? ' group=' + groupId : ''));
}


// createTopic — reads topic name, partition count and replication factor from
// conn, falling back to connector parameters for the numeric defaults.
// Logs a warning rather than throwing if the topic already exists —
// idempotent behaviour is preferable in provisioning ALs.
function adminExecCreateTopic() {
    var topic      = conn.getString('kafka.topic')              || requireParam('topic', 'createTopic');
    var partitions = conn.getString('kafka.partitions')         || getParam('admin_partitions',         '1');
    var replFactor = conn.getString('kafka.replication_factor') || getParam('admin_replication_factor', '1');

    var newTopic = new org.apache.kafka.clients.admin.NewTopic(
        topic,
        new java.lang.Integer(system.toInt(partitions)),
        new java.lang.Short(system.toInt(replFactor))
    );
    var topicList = new java.util.ArrayList();
    topicList.add(newTopic);

    try {
        __adminClient.createTopics(topicList).all().get();
        logmsg('INFO', 'createTopic: created "' + topic + '" partitions=' + partitions + ' replication=' + replFactor);
    } catch(ex) {
        var msg = getErrorMsg(ex);
        if (msg.indexOf('TopicExistsException') >= 0 || msg.indexOf('already exists') >= 0) {
            logmsg('WARN', 'createTopic: topic "' + topic + '" already exists — skipping');
        } else {
            throw new java.lang.RuntimeException('createTopic failed for "' + topic + '": ' + msg);
        }
    }
}


// deleteTopic — reads topic name from conn, falling back to the topic parameter.
// Logs a warning rather than throwing if the topic does not exist.
function adminExecDeleteTopic() {
    var topic     = conn.getString('kafka.topic') || requireParam('topic', 'deleteTopic');
    var topicList = new java.util.ArrayList();
    topicList.add(topic);

    try {
        __adminClient.deleteTopics(topicList).all().get();
        logmsg('INFO', 'deleteTopic: deleted "' + topic + '"');
    } catch(ex) {
        var msg = getErrorMsg(ex);
        if (msg.indexOf('UnknownTopicOrPartitionException') >= 0 || msg.indexOf('does not exist') >= 0) {
            logmsg('WARN', 'deleteTopic: topic "' + topic + '" does not exist — skipping');
        } else {
            throw new java.lang.RuntimeException('deleteTopic failed for "' + topic + '": ' + msg);
        }
    }
}


// =============================================================================
// SELECT ENTRIES
// Client mode: sets up the consumer subscription or partition assignment.
// Admin mode: dispatches to the appropriate adminSelect* function which
// pre-builds all result Entries into __adminBuffer for getNextEntry() to drain.
// =============================================================================

function selectEntries() {

    if (__mode === 'admin') {
        var op = requireParam('admin_operation', 'selectEntries');
        __adminBuffer = null;
        __adminIndex  = 0;
        if      (op === 'listTopics')          { adminSelectListTopics(); }
        else if (op === 'listConsumerGroups')  { adminSelectListConsumerGroups(); }
        else if (op === 'getOffsets')          { adminSelectGetOffsets(); }
        else {
            throw new java.lang.RuntimeException(
                'selectEntries: admin_operation "' + op + '" is not an Iterator operation. '
                + 'Use createTopic or deleteTopic with AddOnly mode.'
            );
        }
        return;
    }

    if (__consumer == null) {
        throw new java.lang.RuntimeException('selectEntries: consumer is null');
    }

    var topic       = requireParam('topic', 'selectEntries');
    var startOffset = getParam('start_offset', '');

    // Clear any prior subscription or assignment before reconfiguring.
    // Required when the cached consumer was previously used with subscribe()
    // and is now being asked to assign(), or vice versa.
    __consumer.unsubscribe();

    if (startOffset !== '') {

        var tpList = new java.util.ArrayList();
        var offset = java.lang.Long(system.toInt(startOffset));

        for (var p in __consumer.partitionsFor(topic)) {
            tpList.add(new org.apache.kafka.common.TopicPartition(topic, p.partition()));
        }

        __consumer.assign(tpList);

        for (var tp in tpList) {
            __consumer.seek(tp, offset);
        }

        logmsg('INFO', 'Assigned ' + tpList.size()
            + ' partition(s) for topic ' + topic + ' seeked to offset ' + offset);

    } else {

        var topicList = new java.util.ArrayList();
        topicList.add(topic);
        __consumer.subscribe(topicList);
        logmsg('INFO', 'Subscribed to topic: ' + topic);

    }

    __msgBuffer   = null;
    __bufferIndex = 0;
}


// =============================================================================
// GET NEXT ENTRY
// Admin mode: drains the pre-built __adminBuffer one Entry at a time.
// Client mode: drains the poll buffer, fetching fresh batches as needed.
// Returns null in both cases to signal end of iteration to the kernel.
// =============================================================================

function getNextEntry() {

    if (__mode === 'admin') {
        if (__adminBuffer == null || __adminIndex >= __adminBuffer.size()) return null;
        entry.merge(__adminBuffer.get(__adminIndex++));
        return;
    }

    if (__consumer == null) {
        logmsg('ERROR', 'getNextEntry: consumer is null');
        return null;
    }

    if (__msgBuffer == null || __bufferIndex >= __msgBuffer.size()) {

        var records = __consumer.poll(
            java.time.Duration.ofMillis(new java.lang.Long(getParam('poll_timeout_ms', '2000')))
        );

        if (records.isEmpty()) return null;

        __msgBuffer   = new java.util.ArrayList();
        __bufferIndex = 0;

        for (var rec in records) { __msgBuffer.add(rec); }

        logmsg('INFO', 'Polled ' + __msgBuffer.size() + ' message(s)');
    }

    var record = __msgBuffer.get(__bufferIndex++);

    try { __consumer.commitSync(); }
    catch(ex) { logmsg('WARN', 'commitSync failed: ' + getErrorMsg(ex)); }

	var e = recordToEntry(record);
    entry.merge(e);
}


// =============================================================================
// PUT ENTRY
// Admin mode: dispatches to createTopic or deleteTopic based on admin_operation.
// Client mode: produces a message to the topic. If kafka.value on conn is null,
// produces a tombstone — allowing AL developers to signal a logical delete via
// AddOnly mode when they do not have a stored partition/offset for Delete mode.
// A tombstone without a key is rejected — the key identifies which record
// the tombstone applies to in a compacted topic.
// =============================================================================

function putEntry() {

    if (__mode === 'admin') {
        var op = requireParam('admin_operation', 'putEntry');
        if      (op === 'createTopic') { adminExecCreateTopic(); }
        else if (op === 'deleteTopic') { adminExecDeleteTopic(); }
        else {
            throw new java.lang.RuntimeException(
                'putEntry: admin_operation "' + op + '" is not a write operation. '
                + 'Use listTopics, listConsumerGroups or getOffsets with Iterator mode.'
            );
        }
        return;
    }

	if (__producer == null) {
		throw new java.lang.RuntimeException('putEntry: producer is null');
	}

	var topic     = entry.getString("topic") || requireParam('topic', 'putEntry');
	var key       = resolveKey();
	var rawValue  = entry.toJSON();
	var value     = (rawValue != null) ? entry.toJSON() : null;
	var operation = (value == null) ? 'delete' : 'add';

	if (value == null && key == null) {
		throw new java.lang.RuntimeException(
			'putEntry: cannot produce a tombstone without a message key. '
			+ 'Set key_attribute to identify which record to tombstone.'
		);
	}

	produceRecord(topic, key, value, operation);
}

// =============================================================================
// FIND ENTRY
// Seeks the lookup consumer to an exact partition + offset and retrieves the
// message at that position. The lookup consumer uses assign() only — no group
// membership, no commits, no effect on broker state.
//
// Link Criteria must supply kafka.offset. kafka.partition is recommended but
// falls back to the sole assigned partition if exactly one is held.
//
// The returned record's offset is validated against the target — if the target
// has been trimmed by retention, Kafka silently returns the next available
// record which we reject rather than return the wrong message.
// =============================================================================

function findEntry() {
	if (__lookupConsumer == null) {
		logmsg('ERROR', 'findEntry: lookup consumer is null');
		result.setStatus(0);
		return;
	}

	try {
		var lc           = getLinkCrit();
		var topic        = lc.topic || getParam('topic', '');
		var partitionNum = resolvePartition(lc, topic);
		var pollMs       = java.lang.Long(system.toInt(getParam('poll_timeout_ms', '2000')));
		var tp           = new org.apache.kafka.common.TopicPartition(topic, partitionNum);
		var tpList       = new java.util.ArrayList();
		tpList.add(tp);
		__lookupConsumer.assign(tpList);

		var found = false;

		// --- Offset-based seek (fast, exact) ---
		if (lc.offset != null && lc.offset.trim() !== '') {
			var targetOffset = java.lang.Long(system.toInt(lc.offset));
			__lookupConsumer.seek(tp, targetOffset);
			logmsg('INFO', 'findEntry: seeking partition=' + partitionNum + ' offset=' + targetOffset);

			var records = __lookupConsumer.poll(java.time.Duration.ofMillis(pollMs)).records(tp);
			for (var i = 0; i < records.size(); i++) {
				var rec = records.get(i);
				if (rec.offset() == targetOffset) {
					connector.addFindEntry(recordToEntry(rec));
					found = true;
					logmsg('INFO', 'findEntry: found at partition=' + partitionNum + ' offset=' + targetOffset);
					lastRec = rec;
					break;
				}
				logmsg('WARN', 'findEntry: offset ' + targetOffset
					+ ' not matched — may have been trimmed by retention policy');
			}

		// --- Key-based scan (slower — scans partition from beginning) ---
		} else {
			// Accept 'key' directly, or the user's own attribute name if it matches key_attribute param
			// e.g. employeeId: emp001 works if key_attribute = employeeId
			var keyAttrName = getParam('key_attribute', '');
			var targetKey   = lc['key'](keyAttrName !== '' ? lc[keyAttrName] : null) || lc['key'];

			if (targetKey == null || targetKey.trim() === '') {
				logmsg('ERROR', 'findEntry: supply offset or key (or ' + (keyAttrName || 'key_attribute') + ') in Link Criteria');
				result.setStatus(0);
				return;
			}

			logmsg('INFO', 'findEntry: scanning partition=' + partitionNum + ' for key=' + targetKey);
			__lookupConsumer.seekToBeginning(tpList);

			// Scan to end — keep last match (latest message wins on non-compacted topics)
			var lastRec   = null;
			var exhausted = false;
			while (!exhausted) {
				var batch = __lookupConsumer.poll(java.time.Duration.ofMillis(pollMs)).records(tp);
				if (batch.size() === 0) {
					exhausted = true;
					break;
				}
				for (var i = 0; i < batch.size(); i++) {
					var rec = batch.get(i);
					if (rec.key() != null && ('' + rec.key()) === targetKey) {
						lastRec = rec;
					}
				}
			}

		}

		if (lastRec != null) {
			connector.addFindEntry(recordToEntry(lastRec));
			found = true;
			logmsg('INFO', 'findEntry: found key=' + targetKey + ' at offset=' + lastRec.offset());
		} else {
			logmsg('WARN', 'findEntry: key=' + targetKey + ' not found in partition=' + partitionNum);
		}

		result.setStatus(found ? 1 : 0);

	} catch(ex) {
		logmsg('ERROR', 'findEntry failed: ' + getErrorMsg(ex));
		result.setStatus(0);
	}
}

// Normalize link criteria keys — strip kafka. or kafka_ prefix
// so users can write offset, key, partition OR kafka.offset etc.
function getLinkCrit() {
	var lc       = {};
	var criteria = search.getCriteria();
	for (var crit in criteria) {
		var name = '' + crit.name;
		if (name.indexOf('kafka.') === 0)      name = name.substring(6);
		else if (name.indexOf('kafka_') === 0)  name = name.substring(6);
		lc[name] = '' + crit.value;
	}
	return lc;
}

function resolvePartition(lc, topic) {
	// 1. Link Criteria
	if (lc.partition != null && lc.partition.trim() !== '') {
		return system.toInt(lc.partition);
	}
	// 2. Connector param
	var paramVal = getParam('partition', '');
	if (paramVal !== '') {
		return system.toInt(paramVal);
	}
	// 3. Single-partition topic fallback — ask the broker
	var partitions = __lookupConsumer.partitionsFor(topic);
	if (partitions.size() === 1) {
		logmsg('WARN', 'partition not supplied — topic has only one partition, defaulting to 0');
		return 0;
	}
	throw new java.lang.RuntimeException(
		'findEntry: partition not supplied. '
		+ 'Topic "' + topic + '" has ' + partitions.size() + ' partitions — cannot determine which to scan. '
		+ 'Supply partition in Link Criteria or set the partition connector parameter.'
	);
}

// =============================================================================
// DELETE ENTRY
// Produces a tombstone (null value, non-null key) to signal logical deletion.
// On log-compacted topics Kafka's compaction process will eventually remove
// all prior messages for this key and then the tombstone itself.
// On non-compacted topics the tombstone is just another message in the log.
// findEntry() acts as TDI's guard — deleteEntry() is only called if the
// record was confirmed found, preventing tombstones for nonexistent keys.
// =============================================================================

function deleteEntry() {

    if (__producer == null) {
        throw new java.lang.RuntimeException('deleteEntry: producer is null');
    }

    var topic = requireParam('topic', 'deleteEntry');
    var key   = resolveKey();

    if (key == null) {
        throw new java.lang.RuntimeException(
            'deleteEntry: key_attribute must be set and have a value mapped to it. '
            + 'A tombstone without a key cannot identify which record to delete.'
        );
    }

    produceRecord(topic, key, null, 'delete');
}


// =============================================================================
// MOD ENTRY / QUERY REPLY / LOOKUP — NOT SUPPORTED
// Included as explicit stubs so unsupported calls surface a clear error
// rather than a silent no-op or a confusing "function not defined" failure.
// =============================================================================

function modEntry() {
    throw new java.lang.RuntimeException(
        'modEntry() is not supported. Kafka is append-only — messages cannot '
        + 'be modified in place. Use putEntry() to append a superseding message '
        + 'or deleteEntry() to tombstone a record.'
    );
}

function queryReply(requestEntry) {
    throw new java.lang.RuntimeException(
        'queryReply() is not supported by this connector.'
    );
}