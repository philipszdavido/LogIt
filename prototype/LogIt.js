/*
It records: 
console logs, 
page load times,
stacktraces,
slow network requests/responses with headers + bodies,
browser metadata,
and custom logs.
*/

var LogIt = {}
var logs = []
var loadStartTime = Date.now()
var loadEndTime = 0
var mutationObserver

function initLogIt(appId) {
    // var log = console.log.bind(console)

    var origConsoleLog = console.log
    var origConsoleError = console.error

    /*console.log = function (params) {
        var data = {
            type: "log",
            data: params
        }
        logs.push(data)
        origConsoleLog(params)
    }*/

    /*console.error = function (params) {
        var data = {
            type: "error",
            data: params
        }
        logs.push(data)
        origConsoleError(params)        
    }*/

    if (window.XMLHttpRequest) {
        const origXMLHttpRequestSend = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.send = function send() {

        }
    }

    if (window.fetch) {
        var origFetch = fetch
        fetch = function fetch(...args) {
            const data = {
                type: "fetch",
                data: args
            }
            logs.push(data)
            origFetch.apply(this, args)
        }
    }

    function mutationObserverFn(mutationsList, observer) {
        for (let index = 0; index < mutationsList.length; index++) {
            const mutation = mutationsList[index];
            switch (mutation.type) {
                case "childList":
                    const data = {
                        type: mutation.type,
                        previousSibling: mutation.previousSibling,
                        nextSibling: mutation.nextSibling,
                        target: mutation.target,
                        addedNodes: mutation.addedNodes
                    }
                    logs.push(mutation)                    
                    break;
            
                default:
                    logs.push(mutation)
                    break;
            }
        }
    }

    const mutationObserverConfig = {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true
    }

    if (window.MutationObserver) {
        mutationObserver = new MutationObserver(mutationObserverFn)
        mutationObserver.observe(document.documentElement, mutationObserverConfig)
    }

    window.document.addEventListener("DOMContentLoaded", (e) => {
        loadEndTime = Date.now()
        var time = Math.ceil((loadEndTime - loadStartTime) / 1000) + "s"

        const data = {
            type: "pageLoadTime",
            data: time
        }
        logs.push(data)
    })
    
}
