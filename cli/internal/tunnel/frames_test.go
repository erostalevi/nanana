package tunnel

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestUUIDAndBinaryFrames(t *testing.T) {
	const s = "0f8fad5b-d9cb-469f-a165-70867728950e"
	id, err := ParseUUID(s)
	if err != nil {
		t.Fatal(err)
	}
	if id[0] != 0x0f || id[15] != 0x0e {
		t.Fatalf("bytes %x", id)
	}
	if FormatUUID(id) != s {
		t.Fatal("format roundtrip")
	}
	f := EncodeBinary(id, []byte("hello"))
	if len(f) != 21 || !bytes.Equal(f[:16], id[:]) {
		t.Fatal("encode layout")
	}
	id2, chunk, err := DecodeBinary(f)
	if err != nil || id2 != id || string(chunk) != "hello" {
		t.Fatal("decode", err)
	}
	if _, c, err := DecodeBinary(f[:16]); err != nil || len(c) != 0 {
		t.Fatal("empty chunk ok")
	}
	if _, _, err := DecodeBinary(f[:10]); err == nil {
		t.Fatal("short frame must error")
	}
	if _, err := ParseUUID("nope"); err == nil {
		t.Fatal("bad uuid")
	}
}

func TestHeadersJSON(t *testing.T) {
	var m Message
	in := `{"t":"req","id":"x","headers":{"a":"1","b":["2","3"]},"bodyLen":4,"replay":true}`
	if err := json.Unmarshal([]byte(in), &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Headers["b"]) != 2 || m.Headers.Get("A") != "1" || !m.Replay || m.BodyLen != 4 {
		t.Fatalf("%+v", m)
	}
	out, _ := json.Marshal(m.Headers)
	var back map[string]interface{}
	_ = json.Unmarshal(out, &back)
	if back["a"] != "1" {
		t.Fatal("single value must marshal as string")
	}
	if _, ok := back["b"].([]interface{}); !ok {
		t.Fatal("multi value must marshal as array")
	}
	if err := json.Unmarshal([]byte(`{"headers":{"a":1}}`), &m); err == nil {
		t.Fatal("number header must fail")
	}
}
