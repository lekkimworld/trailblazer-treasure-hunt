const express = require("express");
const router = express.Router();
const redisClient = require("../configure-redis.js").promisifiedClient;
const bodyParser = require("body-parser");
const events = require("../configure-events.js");
const passport = require("passport");
const Haikunator = require("haikunator");

// generator for fake names using when 
const haikunator = new Haikunator();

/**
 * Return the context in use.
 * @param {String} req 
 */
const getContextForRequest = req => req.params[0] ? `/${req.params[0].split("/")[0]}` : "/";

const getStateForContext = (req) => {
    const ctx = getContextForRequest(req);
    if (!req.session[ctx]) req.session[ctx] = {};
    return req.session[ctx];
}

const getStep0 = (state, ctx, questionnaire, templateCtx, req, res) => {
    templateCtx.title = questionnaire.greetingTitle || "Greetings Trailblazer!";
    templateCtx.text = questionnaire.greetingText || `<p>
            We are so happy you decided to join us on the trail and blaze your way 
            through the treasure hunt. Before we can get 
            going you need to provide a few simple pieces of information on the next 
            screen.
        </p>`;
    return res.render("root", templateCtx);
}

const getStep1 = (state, ctx, questionnaire, templateCtx, req, res) => {
    if (req.session.nameData) templateCtx.nameData = req.session.nameData;
    if (!templateCtx.nameData && process.env.NODE_ENV === "demo") {
        console.log("NODE_ENV === \"demo\" set - adding dummy person info to template context");
        req.session.haiku = haikunator.haikunate();
        templateCtx.nameData = {
            "firstname": "John",
            "lastname": "Doe",
            "company": "Acme Inc.",
            "email": `${req.session.haiku}@example.com`
        }
        templateCtx.lockFields = true;
    }
    return res.render("personal-info", templateCtx);
}

const getStep2 = (state, ctx, questionnaire, templateCtx, req, res) => {
    // render template using questions in sub-key as it otherwised rendered double...
    templateCtx.questions = questionnaire.questions;
    templateCtx.title = questionnaire.questionnaireTitle;
    templateCtx.text = questionnaire.questionnaireText || `<p>
        Below you'll see a list of questions. For each question there is a number of 
        potential answers, decide what's the right answer and answer the question here in the app. Click 
        Next when you are done.
    </p>
    <p>
        Happy trails!
    </p>`;
    return res.render("questions", templateCtx);
}

const getStep3 = (state, ctx, questionnaire, templateCtx, req, res) => {
    // get data from session / state and create payload
    const nameData = req.session.nameData;
    const answers = state.answers;
    const payload = {
        ctx,
        nameData,
        answers
    }

    // send into queue
    events.queues.writesf.publish(payload);

    // delete state data for context from session
    delete req.session[ctx];

    // add text data if any
    templateCtx.title = questionnaire.confirmationTitle || "Thank You!";
    templateCtx.text = questionnaire.confirmationText || `<p>
        We received your information and we are so excited to figure out if you will 
        win the grand prize. 
    </p>
    <p>
        Thank you for playing and see you on the trail!
    </p>`;
    if (process.env.NODE_ENV === "demo") {
        templateCtx.text = templateCtx.text + `<p>Your lottery name is: <br/><b>${req.session.haiku}</b></p>`;
    }

    // return thank you page
    return res.render("final", templateCtx);
}

// use JSON for POST bodies
router.use(bodyParser.json());

router.use((req, res, next) => {
    // ensure we have a session
    if (!req.session) {
        return next(Error('Unable to get session - probably unable to connect to Redis'));
    } else {
        return next();
    }
})

router.get("/logout", (req, res) => {
    console.log(`Logging out user: ${req.session.user.username}`)
    req.logout();
    req.session.destroy();
    res.redirect("/");
})

router.get("/login", passport.authenticate('oauth2', {failureRedirect: "/login"}), (req, res) => {
    console.log("Logging in...");
})

router.get('/oauth/callback', passport.authenticate('oauth2', {failureRedirect: "/login"}), (req, res) => {
    // save in session
    req.session.user = req.user;

    // successful authentication, redirect home.
    res.redirect("/admin/events");
});

/**
 * We use the POST route to receive data from the UI and modify 
 * the state.
 */
router.post("/?*?", (req, res) => {
    // decide on context
    const ctx = getContextForRequest(req);
    const state = getStateForContext(req);

    // get payload
    const payload = req.body;

    // figure out which step we're at
    let step = state.step || 0;

    // write to event stream
    events.topics.events.publish("navigation.post", `User at session ${req.session.id} is at step ${step}`);
    
    // see if there is personal info data in the payload
    if (payload.firstname || payload.lastname || payload.company || payload.email) {
        req.session.nameData = payload;
        if (req.session.nameData.email) req.session.nameData.email = req.session.nameData.email.toLowerCase(); 
    }

    // get questionnaire
    return redisClient.get(`questionnaire:${ctx}`).then(data => {
        if (!data) {
            return Promise.reject(Error(`Unable to find questionnaire for context (${ctx})`));
        }
        return JSON.parse(data);
    }).then(questionnaire => {
        if (payload.answers && questionnaire.enforceCorrect) {
            const answers = payload.answers.reduce((prev, answer) => {
                prev[answer.answerid] = answer;
                return prev;
            }, {});

            // we need to enforce correct answers - figure out what questions are correct
            const questionCount = questionnaire.questionCount;
            let correctCount = 0;
            questionnaire.questions.forEach(question => {
                const correctAnswerId = question.correctAnswerId;
                let correct = false;
                question.answers.forEach(answer => {
                    const actualAnswer = answers[answer.answerid];
                    if (actualAnswer && correctAnswerId === actualAnswer.answerid) correct = true;
                })
                
                const providedAnswer = payload.answers.reduce((prev, answer) => {
                    if (prev) return prev;
                    if (answer.questionid === question.id) return answer
                }, undefined)

                // track correct
                if (correct) correctCount++;
            })

            if (questionCount === correctCount) {
                // all are correct
                return Promise.resolve();
            } else {
                // not all are correct
                return Promise.reject(Error(`Not all answers are correct (${correctCount} of ${questionCount})`));
            }
        } else {
            // do not enfore
            return Promise.resolve();
        }
    }).then(() => {
        // get next step and update state
        if (payload.action === "next") {
            step++;
        } else if (payload.action === "prev") {
            step--;
            if (step < 0) step = 1;
        } else if (payload.action === "restart") {
            step = 0;
        }
        state.step = step;

        // send message to topic
        events.topics.events.publish("status.ok", `User at session ${req.session.id} - answer data in request - succesfully handled post in step ${step}`);

        // update state
        state.answers = payload.answers;
            
        // return
        res.type("json");
        res.send({"status": "ok"});

    }).catch(err => {
        // send error
        events.topics.events.publish("error.answers", `User at session ${req.session.id} - unable to process step ${step} post message: ${err.message}`);
        res.type("json");
        res.send({
            "status": "error",
            "error": err.message
        });
    })

    
})

/**
 * We use the GET route to return the rendered UI for the user 
 * based on the state we have for the user.
 */
router.get("/?*?", (req, res) => {
    // get context and state
    const ctx = getContextForRequest(req);
    const state = getStateForContext(req);

    // figure out where we are in the flow
    let step = state.step || 0;

    const templateCtx = {
        "ctx": {
            "ctx": ctx,
            "state": state
        }
    }
    templateCtx.ctx.stringify = JSON.stringify(templateCtx.ctx);

    // get questionnaire
    return redisClient.get(`questionnaire:${ctx}`).then(data => {
        if (!data) {
            // user trying to access questionnaire we do not know
            throw Error(`Hmmmm no trail here of this name (${ctx})... Did you follow a sign because there's no trailhead here. Sorry!`);
        }
        return JSON.parse(data);

    }).then(questionnaire => {
        if (step === 0) {
            // handle welcome step
            getStep0(state, ctx, questionnaire, templateCtx, req, res);
        } else if (step === 1) {
            // handle the personal info step
            getStep1(state, ctx, questionnaire, templateCtx, req, res);
        } else if (step === 2) {
            // handle go to questions step
            getStep2(state, ctx, questionnaire, templateCtx, req, res);
        } else if (step === 3) {
            // handle final step
            getStep3(state, ctx, questionnaire, templateCtx, req, res);
        } else {
            // coming here is an error
            throw Error("You went past the end of the trail - did you forget to turn? In all seriousness this shouldn't happen!");
        }

        // write to event stream
        events.topics.events.publish("navigation.get", `User at session ${req.session.id} went to step ${step}`);

    }).catch(err => {
        events.topics.events.publish("navigation.error", err.message);
        return res.render("error", {"error": err.message});
    })
})

module.exports = router;
